# temupuffer: common tasks. Run `make help` for the list.
PY      ?= .venv/bin/python
DB      := db
SILO_PF := 19000

.DEFAULT_GOAL := help
.PHONY: help venv test test-s3 test-azure azurite-up azurite-down homelab-apply-azure selftest run-server run-server-2 run-indexer ui-dev ui-build load check-durability \
        local local-down local-reset k3s-install k3s-uninstall k3s-status images homelab-apply \
        napkin-dev napkin-local napkin-local-down napkin-k3s \
        search-test search-dev search-images search-apply search-embed search-load search-cleanup

help: ## Show this list
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

venv: ## Create .venv (Python 3.12) and install dependencies
	python3.12 -m venv .venv && .venv/bin/pip install -q -r db/requirements-dev.txt

test: ## Unit + API tests (in-memory store, no server needed)
	cd $(DB) && ../$(PY) -m pytest -q

test-s3: ## Integration tests against S3_ENDPOINT (e.g. SILO via port-forward)
	cd $(DB) && ../$(PY) -m pytest -q tests/test_s3_integration.py

test-azure: ## Integration tests against Azure Blob (AZURE_STORAGE_CONNECTION_STRING, default: local Azurite)
	cd $(DB) && AZURE_STORAGE_CONNECTION_STRING="$${AZURE_STORAGE_CONNECTION_STRING:-UseDevelopmentStorage=true}" \
	  ../$(PY) -m pytest -q tests/test_s3_integration.py -k azure

azurite-up: ## Local Azure Blob emulator on :10000 (connection string: UseDevelopmentStorage=true)
	docker run -d --rm --name temupuffer-azurite -p 10000:10000 mcr.microsoft.com/azure-storage/azurite:latest \
	  azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck --loose

azurite-down: ## Stop the Azurite emulator (started with --rm, so its data is discarded)
	docker stop temupuffer-azurite

selftest: ## CAS self-test against the configured store (S3_ENDPOINT, or STORE=azure + AZURE_*)
	cd $(DB) && ../$(PY) -m temupuffer.selftest

run-server: ## Query node on :8080 (uses S3_* env vars; STORE=memory for no S3)
	cd $(DB) && NODE_ID=query-local CACHE_DIR=/tmp/tpuf-cache-q1 CORS_ORIGINS=http://localhost:5173 ../$(PY) -m server.main

run-server-2: ## A second query node on :8082, to show any node serves any namespace
	cd $(DB) && NODE_ID=query-local-2 PORT=8082 CACHE_DIR=/tmp/tpuf-cache-q2 ../$(PY) -m server.main

run-indexer: ## Indexer on :8081
	cd $(DB) && NODE_ID=local CACHE_DIR=/tmp/tpuf-cache-idx ../$(PY) -m indexer.main

ui-dev: ## Console dev server on :5173 (proxies /api to :8080)
	cd $(DB)/ui && npm run dev

ui-build: ## Build the console
	cd $(DB)/ui && npm ci && npm run build

load: ## Write 50k docs (TEMUPUFFER_URL, default http://localhost:8080)
	$(PY) scripts/load.py --docs 50000

check-durability: ## Write while you kill a pod, then verify every acked write
	$(PY) scripts/durability.py

local: ## Run everything locally with Docker (deploy/local.sh up)
	./deploy/local.sh up

local-down: ## Stop the local stack (data kept)
	./deploy/local.sh down

local-reset: ## Stop the local stack and delete its data
	./deploy/local.sh reset

k3s-install: ## Install on the current kubectl cluster with bundled S3 (ARGS="--registry ghcr.io/you --host x")
	./deploy/k3s.sh install $(ARGS)

k3s-status: ## Show temupuffer's pods, services and ingress
	./deploy/k3s.sh status $(ARGS)

k3s-uninstall: ## Delete the temupuffer namespace (and the bundled S3's data)
	./deploy/k3s.sh uninstall $(ARGS)

images: ## Build multi-arch images and push them (REGISTRY=registry/owner)
	./deploy/build-images.sh push

homelab-apply: ## The author's own cluster: SILO stack + console, and the Azure stack if .env.azure exists
	kubectl apply -k deploy/overlays/agathla
	@# 0.1.6 moved the query pods from a Deployment to a StatefulSet; remove the old one.
	kubectl -n temupuffer delete deploy/temupuffer-query --ignore-not-found
	kubectl -n temupuffer rollout status statefulset/temupuffer-query --timeout=180s
	kubectl -n temupuffer rollout status deploy/temupuffer-router --timeout=180s
	kubectl -n temupuffer rollout status deploy/temupuffer-indexer --timeout=180s
	@if [ -s .env.azure ]; then $(MAKE) --no-print-directory homelab-apply-azure; \
	 else echo "No .env.azure: skipped the Azure stack (the console's Storage picker will show it as unreachable)"; fi

homelab-apply-azure: ## Only the Azure stack (namespace temupuffer-azure), secrets from .env.azure + the SILO stack's API key
	@test -s .env.azure || { echo ".env.azure is missing (see deploy/README.md, Azure section)"; exit 1; }
	kubectl apply -f deploy/overlays/agathla-azure/namespace.yaml
	kubectl -n temupuffer-azure create secret generic temupuffer-azure --from-env-file=.env.azure \
	  --dry-run=client -o yaml | kubectl apply -f -
	kubectl -n temupuffer get secret temupuffer-api -o jsonpath='{.data.API_KEY}' | base64 -d \
	  | kubectl -n temupuffer-azure create secret generic temupuffer-api --from-file=API_KEY=/dev/stdin \
	    --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -k deploy/overlays/agathla-azure
	kubectl -n temupuffer-azure delete deploy/temupuffer-query --ignore-not-found
	kubectl -n temupuffer-azure rollout status statefulset/temupuffer-query --timeout=180s
	kubectl -n temupuffer-azure rollout status deploy/temupuffer-indexer --timeout=180s

napkin-dev: ## Napkin Math UI dev server on :5178 (napkin-math-ui/)
	cd napkin-math-ui && npm start

napkin-local: ## Napkin Math UI production image on :8080
	./napkin-math-ui/deploy.sh local

napkin-local-down: ## Stop the local Napkin Math UI container
	./napkin-math-ui/deploy.sh local-down

napkin-k3s: ## Build, push and roll out Napkin Math UI (napkinmath.agathla.com)
	./napkin-math-ui/deploy.sh k3s

# --- temupuffer search (demo-app/) -----------------------------------------------------------
SEARCH_NS ?= temupuffer-search
DOCS ?= 100000
BACKEND ?= temupuffer
SKIP ?= 0
# The image the Jobs run: whatever the overlay pins (tag or digest).
SEARCH_IMAGE = $(shell kubectl kustomize deploy/overlays/agathla-search | awk '/image: .*temupuffer-search[:@]/ {print $$2; exit}')

search-test: ## demo-app unit tests (demo-app/.venv)
	cd demo-app && .venv/bin/python -m pytest -q tests

search-images: ## Build + push the search images (REGISTRY=git.agathla.com/papi by default)
	REGISTRY=$${REGISTRY:-git.agathla.com/papi} ./deploy/build-images.sh push-search

search-apply: ## Deploy temupuffer search to the homelab (namespace temupuffer-search)
	./deploy/overlays/agathla-search/create-secrets.sh
	kubectl apply -k deploy/overlays/agathla-search
	kubectl -n $(SEARCH_NS) rollout status deploy/search-embedder --timeout=180s
	kubectl -n $(SEARCH_NS) rollout status deploy/search-api --timeout=180s
	kubectl -n $(SEARCH_NS) rollout status deploy/search-ui --timeout=120s

search-embed: ## Embed DOCS papers (3 pods, resumable): make search-embed DOCS=100000
	kubectl -n $(SEARCH_NS) delete job search-embed --ignore-not-found
	sed -e 's|__DOCS__|$(DOCS)|' -e 's|image: temupuffer-search$$|image: $(SEARCH_IMAGE)|' demo-app/search/jobs/embed.yaml \
	  | kubectl -n $(SEARCH_NS) apply -f -
	@echo "Follow: kubectl -n $(SEARCH_NS) logs -f -l app.kubernetes.io/name=search-embed --max-log-requests 3 --prefix"

search-load: ## Load DOCS embedded papers: make search-load DOCS=100000 [SKIP=N to resume] [BACKEND=turbopuffer]
	kubectl -n $(SEARCH_NS) delete job search-load --ignore-not-found
	sed -e 's|__DOCS__|$(DOCS)|' -e 's|__BACKEND__|$(BACKEND)|' -e 's|__SKIP__|$(SKIP)|' -e 's|image: temupuffer-search$$|image: $(SEARCH_IMAGE)|' \
	  demo-app/search/jobs/load.yaml | kubectl -n $(SEARCH_NS) apply -f -
	@echo "Follow: kubectl -n $(SEARCH_NS) logs -f job/search-load   (or the Scale page)"

search-cleanup: ## Delete the search namespace on BACKEND (turbopuffer: only demo-arxiv)
	kubectl -n $(SEARCH_NS) exec deploy/search-api -- python -m search.ingest cleanup --backend $(BACKEND)
