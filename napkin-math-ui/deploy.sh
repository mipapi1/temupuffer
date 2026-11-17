#!/usr/bin/env bash
# Deploy Napkin Math UI.
#
#   ./deploy.sh local          build the production image and run it at http://localhost:8080
#   ./deploy.sh local-down     stop the local container
#   ./deploy.sh k3s            build (amd64 + arm64), push to the registry, apply to the current
#                              kubectl context, wait for the rollout
#   ./deploy.sh status         pods, service and ingress on the cluster
#   ./deploy.sh k3s-down       delete the napkin-math namespace
#
# Settings (environment variables):
#   PORT=8080                                   local port
#   REGISTRY=git.agathla.com/papi               image registry/owner (run `docker login` once)
#   HOST=napkinmath.agathla.com                 public hostname for the ingress
#   KUBE_CONTEXT=<current context>              which cluster to deploy to
set -euo pipefail
cd "$(dirname "$0")"

NAME=napkin-math-ui
NS=napkin-math
PORT=${PORT:-8080}
REGISTRY=${REGISTRY:-git.agathla.com/papi}
HOST=${HOST:-napkinmath.agathla.com}
IMAGE="$REGISTRY/$NAME"
KUBECTL=(kubectl ${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"})

tag() {
  local t
  t=$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
  [ -n "$(git status --porcelain 2>/dev/null)" ] && t="$t-dirty"
  echo "$t"
}

case "${1:-}" in
  local)
    docker build -t "$NAME:local" .
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:8080" "$NAME:local" >/dev/null
    echo "Running at http://localhost:$PORT  (stop with ./deploy.sh local-down)"
    ;;

  local-down)
    docker rm -f "$NAME" >/dev/null && echo "Stopped."
    ;;

  k3s)
    t=$(tag)
    meta=$(mktemp)
    trap 'rm -f "$meta"' EXIT
    docker buildx inspect "$NAME" >/dev/null 2>&1 || docker buildx create --name "$NAME" >/dev/null
    # No attestations: Forgejo's registry can attach the tag to the attestation index.
    docker buildx build --builder "$NAME" --platform linux/amd64,linux/arm64 --provenance=false --sbom=false \
      -t "$IMAGE:$t" -t "$IMAGE:latest" --metadata-file "$meta" --push .
    digest=$(sed -n 's/.*"containerimage.digest": *"\([^"]*\)".*/\1/p' "$meta")
    [ -n "$digest" ] || { echo "Couldn't read the image digest from the build." >&2; exit 1; }
    echo "Pushed $IMAGE:$t ($digest)"

    # Pin the image by digest and set the hostname, without editing the checked-in manifests.
    "${KUBECTL[@]}" kustomize deploy/k8s \
      | sed -e "s#image: $IMAGE:latest#image: $IMAGE@$digest#" \
            -e "s#host: napkinmath.agathla.com#host: $HOST#" \
      | "${KUBECTL[@]}" apply -f -
    "${KUBECTL[@]}" -n "$NS" rollout status deploy/napkin-math --timeout=180s
    echo "Live at https://$HOST"
    ;;

  status)
    "${KUBECTL[@]}" -n "$NS" get pods,svc,ingress -o wide
    ;;

  k3s-down)
    "${KUBECTL[@]}" delete namespace "$NS"
    ;;

  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
