#!/usr/bin/env bash
# Run temupuffer on this machine with Docker: SILO (S3) + 2 query nodes + indexer + console.
#
#   ./deploy/local.sh up        build and start, wait until ready, print the URL and API key
#   ./deploy/local.sh status    containers and health
#   ./deploy/local.sh logs      follow the logs
#   ./deploy/local.sh down      stop (data is kept)
#   ./deploy/local.sh reset     stop and delete all data
#
# Ports can be changed if they're taken:
#   CONSOLE_PORT=3000 S3_PORT=19000 S3_CONSOLE_PORT=19001 TEMUPUFFER_API_KEY=tpuf-dev-key ./deploy/local.sh up
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)"
docker info >/dev/null 2>&1 || die "the Docker daemon isn't running. Start Docker Desktop (or your Docker engine) and retry."

export CONSOLE_PORT=${CONSOLE_PORT:-3000}
export S3_PORT=${S3_PORT:-19000}
export S3_CONSOLE_PORT=${S3_CONSOLE_PORT:-19001}
export TEMUPUFFER_API_KEY=${TEMUPUFFER_API_KEY:-tpuf-dev-key}
compose=(docker compose -f docker-compose.yml)

case "${1:-up}" in
  up)
    for port in "$CONSOLE_PORT" "$S3_PORT" "$S3_CONSOLE_PORT"; do
      if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && ! "${compose[@]}" ps -q 2>/dev/null | grep -q .; then
        die "port $port is already in use. Pick another, e.g. CONSOLE_PORT=3100 S3_PORT=19100 S3_CONSOLE_PORT=19101 $0 up"
      fi
    done
    say "Building and starting (the first run downloads base images and takes a few minutes)"
    "${compose[@]}" up -d --build
    say "Waiting for the query nodes to pass their storage self-test"
    for _ in $(seq 1 90); do
      if curl -fsS "http://localhost:$CONSOLE_PORT/api/readyz" >/dev/null 2>&1; then
        echo
        say "temupuffer is running"
        echo "  Console:     http://localhost:$CONSOLE_PORT   (API key: $TEMUPUFFER_API_KEY)"
        echo "  API:         http://localhost:$CONSOLE_PORT/api   e.g. curl -H 'Authorization: Bearer $TEMUPUFFER_API_KEY' http://localhost:$CONSOLE_PORT/api/v1/namespaces"
        echo "  S3 console:  http://localhost:$S3_CONSOLE_PORT   (minioadmin / minioadmin)"
        echo "  Load data:   TEMUPUFFER_URL=http://localhost:$CONSOLE_PORT/api python scripts/load.py --docs 50000"
        echo "               (needs Python 3.11+ with httpx and numpy: make venv)"
        echo "  Walkthrough: docs/walkthrough.md     Stop: ./deploy/local.sh down"
        exit 0
      fi
      sleep 2
    done
    "${compose[@]}" ps
    die "not ready after 3 minutes. See: ./deploy/local.sh logs"
    ;;
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs -f --tail=100 ;;
  down) "${compose[@]}" down; say "Stopped. Data is kept; './deploy/local.sh reset' deletes it." ;;
  reset) "${compose[@]}" down -v; say "Stopped and deleted all data." ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
