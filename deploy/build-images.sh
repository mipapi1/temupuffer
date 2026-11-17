#!/usr/bin/env bash
# Build the two temupuffer images (temupuffer-db and temupuffer-console).
#
#   REGISTRY=ghcr.io/you ./deploy/build-images.sh push
#       multi-arch (linux/amd64 + linux/arm64), pushed to $REGISTRY
#   REGISTRY=ghcr.io/you ./deploy/build-images.sh push-search
#       the same for temupuffer search (temupuffer-search, temupuffer-search-ui), tag SEARCH_TAG
#   ./deploy/build-images.sh load amd64
#       one architecture, loaded into the local Docker as temupuffer/temupuffer-*:$TAG
#       (deploy/k3s.sh then imports them into the cluster)
#
# TAG defaults to 0.1.11.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG=${TAG:-0.1.11}
mode=${1:-}

case "$mode" in
  push)
    : "${REGISTRY:?set REGISTRY, e.g. REGISTRY=ghcr.io/you}"
    docker buildx inspect temupuffer >/dev/null 2>&1 || docker buildx create --name temupuffer >/dev/null
    for img in db:db console:db/ui; do
      name=${img%%:*}; ctx=${img#*:}
      docker buildx build --builder temupuffer --platform linux/amd64,linux/arm64 \
        -t "$REGISTRY/temupuffer-$name:$TAG" --push "$ctx"
    done
    echo "Pushed $REGISTRY/temupuffer-db:$TAG and $REGISTRY/temupuffer-console:$TAG"
    ;;
  push-search)
    # temupuffer search (demo-app/): its own version, SEARCH_TAG.
    : "${REGISTRY:?set REGISTRY, e.g. REGISTRY=ghcr.io/you}"
    STAG=${SEARCH_TAG:-0.2.5}
    docker buildx inspect temupuffer >/dev/null 2>&1 || docker buildx create --name temupuffer >/dev/null
    for img in search:demo-app search-ui:demo-app/ui; do
      name=${img%%:*}; ctx=${img#*:}
      docker buildx build --builder temupuffer --platform linux/amd64,linux/arm64 \
        -t "$REGISTRY/temupuffer-$name:$STAG" --push "$ctx"
    done
    echo "Pushed $REGISTRY/temupuffer-search:$STAG and $REGISTRY/temupuffer-search-ui:$STAG"
    ;;
  load)
    arch=${2:?usage: $0 load <amd64|arm64>}
    for img in db:db console:db/ui; do
      name=${img%%:*}; ctx=${img#*:}
      docker buildx build --platform "linux/$arch" -t "temupuffer/temupuffer-$name:$TAG" --load "$ctx"
    done
    echo "Built temupuffer/temupuffer-db:$TAG and temupuffer/temupuffer-console:$TAG for linux/$arch"
    ;;
  *)
    echo "usage: REGISTRY=<registry/owner> $0 push|push-search   |   $0 load <amd64|arm64>" >&2
    exit 1
    ;;
esac
