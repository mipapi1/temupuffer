#!/usr/bin/env bash
# Creates Secret "search-secrets" in namespace temupuffer-search, with values COPIED
# (never referenced across namespaces):
#   TEMUPUFFER_API_KEY                         from temupuffer/temupuffer-api
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  from temupuffer/temupuffer-s3 (SILO, for the embeddings bucket)
#   TURBOPUFFER_API_KEY / TURBOPUFFER_REGION   from demo-app/.env, only if that file sets them
# Safe to re-run: it rewrites the Secret from the current sources.
set -euo pipefail
cd "$(dirname "$0")/../../.."
kubectl get namespace temupuffer-search >/dev/null 2>&1 || kubectl create namespace temupuffer-search

get() { kubectl -n temupuffer get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
args=(--from-literal=TEMUPUFFER_API_KEY="$(get temupuffer-api API_KEY)"
      --from-literal=AWS_ACCESS_KEY_ID="$(get temupuffer-s3 AWS_ACCESS_KEY_ID)"
      --from-literal=AWS_SECRET_ACCESS_KEY="$(get temupuffer-s3 AWS_SECRET_ACCESS_KEY)")

# Read only the two turbopuffer keys from demo-app/.env (never `source` it).
if [[ -f demo-app/.env ]]; then
  for k in TURBOPUFFER_API_KEY TURBOPUFFER_REGION; do
    v=$(grep -E "^$k=" demo-app/.env | tail -1 | cut -d= -f2- || true)
    [[ -n "$v" ]] && args+=(--from-literal="$k=$v")
  done
fi

kubectl -n temupuffer-search create secret generic search-secrets "${args[@]}" --dry-run=client -o yaml | kubectl apply -f -
echo "search-secrets: written ($(( ${#args[@]} )) keys)"
