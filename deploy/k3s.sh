#!/usr/bin/env bash
# Install temupuffer on a K3s cluster (or any Kubernetes with an ingress controller).
#
#   ./deploy/k3s.sh install                      everything, with its own S3 (SILO), in namespace "temupuffer"
#   ./deploy/k3s.sh install --registry ghcr.io/you        push images to a registry and pull from there
#   ./deploy/k3s.sh install --import ssh:node1,node2      no registry: copy images to each node over SSH
#   ./deploy/k3s.sh install --host temupuffer.example.com add a hostname to the console Ingress
#   ./deploy/k3s.sh install --s3-endpoint http://minio.storage:9000 --s3-bucket temupuffer
#                                                use an existing S3 (set S3_ACCESS_KEY and S3_SECRET_KEY)
#   ./deploy/k3s.sh status
#   ./deploy/k3s.sh uninstall                    deletes the namespace, including the bundled S3's data
#
# Other options: --namespace NAME, --tag TAG, --no-build (images already in --registry), --yes.
#
# Getting images into the cluster, without --registry (--import, default "auto"):
#   K3s on this machine       sudo k3s ctr images import          (asks for sudo)
#   k3d                       k3d image import
#   Docker Desktop / OrbStack nothing to do: the cluster uses the local Docker image store
#   remote K3s nodes          --import ssh:node1,node2 (streams the image into each node over SSH)
set -euo pipefail
cd "$(dirname "$0")/.."

cmd=${1:-help}; shift || true
NS=${NS:-temupuffer}
TAG=0.1.7
REGISTRY=""
IMPORT=auto
HOST=""
S3_ENDPOINT=""
S3_BUCKET=temupuffer
BUILD=1
YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NS=$2; shift 2 ;;
    --tag) TAG=$2; shift 2 ;;
    --registry) REGISTRY=${2%/}; shift 2 ;;
    --import) IMPORT=$2; shift 2 ;;
    --host) HOST=$2; shift 2 ;;
    --s3-endpoint) S3_ENDPOINT=$2; shift 2 ;;
    --s3-bucket) S3_BUCKET=$2; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --yes|-y) YES=1; shift ;;
    *) echo "unknown option $1 (see the top of $0)" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required ($2)"; }

check_cluster() {
  need kubectl "https://kubernetes.io/docs/tasks/tools/"
  need openssl "it generates the credentials"
  kubectl version --request-timeout=5s >/dev/null 2>&1 || die "can't reach a cluster with kubectl (current context: $(kubectl config current-context 2>/dev/null || echo none))"
}

node_arch() {
  local archs
  archs=$(kubectl get nodes -o jsonpath='{range .items[*]}{.status.nodeInfo.architecture}{"\n"}{end}' | sort -u)
  [[ $(echo "$archs" | wc -l | tr -d ' ') == 1 ]] || die "nodes have mixed architectures ($archs): use --registry, which builds multi-arch images"
  echo "$archs"
}

# --- images ---------------------------------------------------------------------

images() {
  if [[ -n "$REGISTRY" ]]; then
    if [[ $BUILD == 1 ]]; then
      need docker "https://docs.docker.com/get-docker/"
      say "Building multi-arch images and pushing to $REGISTRY"
      REGISTRY=$REGISTRY TAG=$TAG ./deploy/build-images.sh push
    fi
    DB_IMAGE=$REGISTRY/temupuffer-db; CONSOLE_IMAGE=$REGISTRY/temupuffer-console
    return
  fi
  DB_IMAGE=temupuffer/temupuffer-db; CONSOLE_IMAGE=temupuffer/temupuffer-console
  [[ $BUILD == 1 ]] || return 0
  need docker "https://docs.docker.com/get-docker/"
  local arch ctx
  arch=$(node_arch) || exit 1
  say "Building images for linux/$arch"
  TAG=$TAG ./deploy/build-images.sh load "$arch"
  ctx=$(kubectl config current-context)
  local refs=("$DB_IMAGE:$TAG" "$CONSOLE_IMAGE:$TAG")
  case "$IMPORT" in
    auto)
      if [[ $ctx == k3d-* ]]; then
        need k3d "https://k3d.io"
        say "Importing into k3d cluster ${ctx#k3d-}"
        k3d image import -c "${ctx#k3d-}" "${refs[@]}"
      elif [[ $ctx == docker-desktop || $ctx == orbstack ]]; then
        say "$ctx shares the local Docker image store: nothing to import"
      elif command -v k3s >/dev/null 2>&1; then
        say "Importing into this machine's K3s (sudo k3s ctr images import)"
        docker save "${refs[@]}" | sudo k3s ctr images import -
      else
        die "can't tell how to get images into context '$ctx'. Use --registry <registry/owner>, or --import ssh:node1,node2 for remote K3s nodes"
      fi
      ;;
    ssh:*)
      local nodes=${IMPORT#ssh:}
      for node in ${nodes//,/ }; do
        say "Importing into $node over SSH"
        docker save "${refs[@]}" | ssh "$node" sudo k3s ctr images import -
      done
      ;;
    none) say "Skipping import (--import none)" ;;
    *) die "unknown --import mode $IMPORT (auto, ssh:node1,node2 or none)" ;;
  esac
}

# --- secrets ----------------------------------------------------------------------

rand() { openssl rand -hex "$(( $1 / 2 ))"; }   # $1 hex characters

secrets() {
  kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS" >/dev/null
  if ! kubectl -n "$NS" get secret temupuffer-s3 >/dev/null 2>&1; then
    local user pass
    if [[ -n "$S3_ENDPOINT" ]]; then
      user=${S3_ACCESS_KEY:?set S3_ACCESS_KEY for --s3-endpoint}
      pass=${S3_SECRET_KEY:?set S3_SECRET_KEY for --s3-endpoint}
    else
      user="temupuffer"; pass=$(rand 32)   # credentials for the bundled SILO
    fi
    kubectl -n "$NS" create secret generic temupuffer-s3 \
      --from-literal=AWS_ACCESS_KEY_ID="$user" --from-literal=AWS_SECRET_ACCESS_KEY="$pass" >/dev/null
    say "Created Secret temupuffer-s3"
  fi
  if ! kubectl -n "$NS" get secret temupuffer-api >/dev/null 2>&1; then
    kubectl -n "$NS" create secret generic temupuffer-api --from-literal=API_KEY="tpuf-$(rand 32)" >/dev/null
    say "Created Secret temupuffer-api (a random API key)"
  fi
}

# --- manifests ----------------------------------------------------------------------

generate() {
  # A small kustomization layered on the repo's manifests with this install's
  # choices. It lives in deploy/.generated/ (gitignored) so you can inspect it,
  # re-apply it, or check it into your own repo.
  GEN=deploy/.generated/$NS
  mkdir -p "$GEN"
  {
    echo "# Generated by deploy/k3s.sh. Apply with: kubectl apply -k $GEN"
    echo "apiVersion: kustomize.config.k8s.io/v1beta1"
    echo "kind: Kustomization"
    echo "namespace: $NS"
    if [[ -z "$S3_ENDPOINT" ]]; then
      echo "resources:"
      echo "  - ../../overlays/k3s          # base + bundled SILO + console Ingress"
    else
      echo "resources:"
      echo "  - namespace.yaml"
      echo "  - ../../base"
      echo "components:"
      echo "  - ../../components/console-ingress"
      echo "configMapGenerator:"
      echo "  - name: temupuffer-s3-endpoint"
      echo "    literals: [\"S3_ENDPOINT=$S3_ENDPOINT\"]"
      echo "    options: {disableNameSuffixHash: true}"
    fi
    # Image names as the layer below leaves them: overlays/k3s has already
    # renamed temupuffer-db to temupuffer/temupuffer-db; base hasn't.
    local from=""
    [[ -z "$S3_ENDPOINT" ]] && from="temupuffer/"
    echo "images:"
    echo "  - {name: ${from}temupuffer-db, newName: $DB_IMAGE, newTag: \"$TAG\"}"
    echo "  - {name: ${from}temupuffer-console, newName: $CONSOLE_IMAGE, newTag: \"$TAG\"}"
    echo "patches:"
    echo "  - target: {kind: ConfigMap, name: temupuffer-config}"
    echo "    patch: |-"
    echo "      - {op: replace, path: /data/S3_BUCKET, value: \"$S3_BUCKET\"}"
    if [[ -n "$HOST" ]]; then
      echo "  - target: {kind: Ingress, name: temupuffer}"
      echo "    patch: |-"
      echo "      - {op: add, path: /spec/rules/0/host, value: \"$HOST\"}"
    fi
  } > "$GEN/kustomization.yaml"
  if [[ -n "$S3_ENDPOINT" ]]; then
    printf 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: %s\n' "$NS" > "$GEN/namespace.yaml"
  fi
}

wait_ready() {
  say "Waiting for pods (the first start pulls images and waits for S3)"
  [[ -z "$S3_ENDPOINT" ]] && kubectl -n "$NS" rollout status statefulset/temupuffer-s3 --timeout=300s
  kubectl -n "$NS" rollout status statefulset/temupuffer-query --timeout=300s
  for d in temupuffer-indexer temupuffer-console; do
    kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s
  done
}

access_info() {
  local addr key
  addr=$(kubectl -n "$NS" get ingress temupuffer -o jsonpath='{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  key=$(kubectl -n "$NS" get secret temupuffer-api -o jsonpath='{.data.API_KEY}' | base64 -d)
  echo
  say "temupuffer is running in namespace $NS"
  if [[ -n "$HOST" ]]; then
    echo "  Console:  http://$HOST/   (point $HOST at ${addr:-your ingress controller})"
  elif [[ -n "$addr" ]]; then
    echo "  Console:  http://$addr/"
  else
    echo "  Console:  no ingress address yet. Meanwhile: kubectl -n $NS port-forward svc/temupuffer-console 3000:80  -> http://localhost:3000"
  fi
  echo "  API:      the console proxies it at /api, e.g.  curl -H \"Authorization: Bearer \$KEY\" <console-url>/api/v1/namespaces"
  echo "  API key:  $key"
  echo "            (again later: kubectl -n $NS get secret temupuffer-api -o jsonpath='{.data.API_KEY}' | base64 -d)"
  echo "  Try it:   TEMUPUFFER_URL=<console-url>/api TEMUPUFFER_API_KEY=$key python scripts/load.py --docs 50000"
  echo "  Walkthrough: docs/walkthrough.md"
}

case "$cmd" in
  install)
    check_cluster
    images
    secrets
    generate
    say "Applying $GEN"
    kubectl apply -k "$GEN"
    # Upgrades from 0.1.5: the query pods moved from a Deployment to a StatefulSet.
    kubectl -n "$NS" delete deploy/temupuffer-query --ignore-not-found
    wait_ready
    access_info
    ;;
  status)
    check_cluster
    kubectl -n "$NS" get pods,svc,ingress,pvc
    ;;
  uninstall)
    check_cluster
    kubectl get namespace "$NS" >/dev/null 2>&1 || die "namespace $NS doesn't exist"
    if [[ $YES != 1 ]]; then
      read -r -p "Delete namespace $NS and everything in it (including the bundled S3 data)? [y/N] " ok
      [[ $ok == y || $ok == Y ]] || exit 1
    fi
    kubectl delete namespace "$NS" --wait=true
    rm -rf "deploy/.generated/$NS"
    say "Removed $NS. An external S3 bucket (--s3-endpoint) is left untouched."
    ;;
  *)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
