#!/usr/bin/env bash
# Creates the two Secrets temupuffer needs in namespace "temupuffer":
#   temupuffer-s3   SILO credentials, COPIED from turbopuffer/silo-root (the
#                   temupuffer namespace never references the other namespace's Secret)
#   temupuffer-api  a random API key (bearer token) for the temupuffer API
# Safe to re-run: existing Secrets are left alone unless you pass --rotate-api-key.
set -euo pipefail

kubectl get namespace temupuffer >/dev/null 2>&1 || kubectl create namespace temupuffer

user=$(kubectl -n turbopuffer get secret silo-root -o jsonpath='{.data.MINIO_ROOT_USER}' | base64 -d)
pass=$(kubectl -n turbopuffer get secret silo-root -o jsonpath='{.data.MINIO_ROOT_PASSWORD}' | base64 -d)
kubectl -n temupuffer create secret generic temupuffer-s3 \
  --from-literal=AWS_ACCESS_KEY_ID="$user" --from-literal=AWS_SECRET_ACCESS_KEY="$pass" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "temupuffer-s3: copied from turbopuffer/silo-root"

if ! kubectl -n temupuffer get secret temupuffer-api >/dev/null 2>&1 || [[ "${1:-}" == "--rotate-api-key" ]]; then
  key="tpuf-$(openssl rand -hex 16)"
  kubectl -n temupuffer create secret generic temupuffer-api --from-literal=API_KEY="$key" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "temupuffer-api: created. Your API key:"
  echo "  $key"
  echo "(read it again any time: kubectl -n temupuffer get secret temupuffer-api -o jsonpath='{.data.API_KEY}' | base64 -d)"
else
  echo "temupuffer-api: already exists (pass --rotate-api-key to replace it)"
fi
