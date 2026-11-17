# Deploying temupuffer

I run temupuffer two ways, each with one command:

| Where | Command | You need |
|---|---|---|
| Your machine | `./deploy/local.sh up` | Docker with Compose v2 |
| A K3s cluster | `./deploy/k3s.sh install` | `kubectl` pointed at the cluster, Docker (to build images), `openssl` |

Both run the same pieces: S3-compatible storage (SILO), two query nodes, one indexer and the
console. Both print the console URL and the API key when they finish. On my own homelab I use a
third setup, `make homelab-apply` (overlay `overlays/agathla`), which plugs into my existing SILO.

## Local (Docker Compose)

```bash
./deploy/local.sh up        # build, start, wait for the storage self-test, print URL + key
./deploy/local.sh status
./deploy/local.sh logs
./deploy/local.sh down      # stop, keep data
./deploy/local.sh reset     # stop, delete data
```

- Console: http://localhost:3000, API key `tpuf-dev-key`. The API is the same origin under `/api`.
- S3 console (browse the bucket): http://localhost:19001, `minioadmin` / `minioadmin`.
- Ports taken? `CONSOLE_PORT=3100 S3_PORT=19100 S3_CONSOLE_PORT=19101 ./deploy/local.sh up`.
- Different key: `TEMUPUFFER_API_KEY=... ./deploy/local.sh up`.
- The first run builds two images and pulls SILO, Python, Node and nginx. After that it's seconds.
- temupuffer-search can run here too, at http://localhost:3001:
  `docker compose -f deploy/docker-compose.yml --profile search up -d --build`, then embed and load a
  few thousand papers (the commands are at the top of the search section in `docker-compose.yml`).
  I tested this on 2026-11-17: 2,000 papers, all three search modes working.

`make local`, `make local-down` and `make local-reset` do the same.

## K3s

```bash
./deploy/k3s.sh install                         # namespace "temupuffer", bundled S3, console on the ingress
./deploy/k3s.sh status
./deploy/k3s.sh uninstall                       # deletes the namespace, including the bundled S3 data
```

What `install` does, in order:

1. **Images.** Builds them for your nodes' architecture and gets them into the cluster. Without
   `--registry` it picks a way automatically:

   | Your cluster | How the images get in |
   |---|---|
   | K3s on this machine | `docker save \| sudo k3s ctr images import -` (asks for sudo) |
   | k3d | `k3d image import` |
   | Docker Desktop / OrbStack Kubernetes | nothing: the cluster sees local Docker images |
   | Remote K3s nodes | `--import ssh:node1,node2,node3` (streams the images over SSH, needs sudo there) |
   | Anything, via a registry | `--registry ghcr.io/you` (multi-arch build + push; nodes must be able to pull) |

2. **Secrets** (only if missing): `temupuffer-s3` (random credentials for the bundled S3, or yours
   with `--s3-endpoint`) and `temupuffer-api` (a random API key).
3. **Manifests.** Writes a small kustomization to `deploy/.generated/<namespace>/` with your
   choices layered on the repo's manifests, then `kubectl apply -k` it. Inspect it, re-apply it, or
   copy it into your own GitOps repo.
4. **Waits** for every rollout, then prints the console URL, the API key and a load-test command.

Options:

| Option | Default | |
|---|---|---|
| `--namespace NAME` | `temupuffer` | install several copies side by side |
| `--host NAME` | none | add a hostname to the Ingress. **Use this on a shared cluster**: without a host the Ingress answers on every hostname nothing else claims |
| `--registry R` | none | push to and pull from `R/temupuffer-db`, `R/temupuffer-console` |
| `--no-build` | build | images are already in `--registry` |
| `--tag T` | `0.1.7` | image tag |
| `--import MODE` | `auto` | `auto`, `ssh:n1,n2` or `none` |
| `--s3-endpoint URL` | bundled SILO | use existing S3/MinIO; set `S3_ACCESS_KEY` and `S3_SECRET_KEY`. It must honour `If-None-Match: *` and `If-Match` (pods refuse to start otherwise) |
| `--s3-bucket B` | `temupuffer` | created on startup if missing |
| `--yes` | ask | skip the uninstall confirmation |

Reaching it: with no `--host`, open `http://<node-ip>/` (the script prints the ingress address).
The API is behind the console at `/api`:
`curl -H "Authorization: Bearer $KEY" http://<node-ip>/api/v1/namespaces`. No ingress controller?
`kubectl -n temupuffer port-forward svc/temupuffer-console 3000:80`.

The bundled S3 is a single SILO pod with a 10 Gi PVC on the default StorageClass (`local-path` on
stock K3s). That's fine for learning. For anything you care about, point `--s3-endpoint` at real
object storage.

## Layout

```
deploy/
  local.sh  k3s.sh  build-images.sh  docker-compose.yml
  base/                       query nodes, indexer, console, config. No namespace, no ingress, no S3
  components/bundled-s3/      SILO StatefulSet + Service + S3_ENDPOINT
  components/console-ingress/ host-less Ingress to the console
  overlays/k3s/               base + both components, namespace "temupuffer" (what k3s.sh builds on)
  overlays/agathla/           my homelab: external SILO, Forgejo images, two hostnames
  .generated/                 written by k3s.sh (gitignored)
```

| Object | Why |
|---|---|
| `StatefulSet/temupuffer-query` (2 replicas) | stateless query nodes; a StatefulSet only for stable pod names (the routing ring), no volumes; spread across nodes; PDB `minAvailable: 1`; `emptyDir` cache standing in for NVMe |
| `Service/temupuffer-query` + headless `temupuffer-query-peers` | any-pod access, plus per-pod DNS for the routing ring and the console's cluster view |
| `Deployment/temupuffer-indexer` + headless Service | the indexer and its stats endpoint |
| `Deployment/temupuffer-console` | nginx serving the React build, proxying `/api` to the query pods with namespace affinity (`QUERY_RING`, see `db/ui/backends.sh`) |
| `Deployment/temupuffer-router` (component `api-router`, homelab only) | the same nginx ring on port 8081, behind the API hostname, so API clients get namespace affinity too |
| `ConfigMap/temupuffer-config` | tunables (see `db/temupuffer/config.py`) |
| `Secret/temupuffer-s3`, `Secret/temupuffer-api` | S3 credentials, API key |

Pods are probed on `/readyz`, which passes only after the CAS self-test. At startup they wait up to
3 minutes for object storage (so they don't crash-loop while a bundled S3 starts), but stop
immediately if the store ignores a conditional-write header. They run as non-root with a read-only
root filesystem.

## Azure Blob Storage instead of S3

`STORE=azure` swaps the S3 client for `AzureBlobStore` (details and verified behaviour:
[docs/object-storage.md](../docs/object-storage.md#temupuffers-azureblobstore-added-2026-11-10-storeazure)).

**Storage account:** StorageV2 (general purpose v2), any redundancy. Leave **hierarchical namespace
off** (that's ADLS Gen2, which changes listing order and blob semantics; untested). The pods
must be able to reach `https://<account>.blob.core.windows.net` (public endpoint, or a firewall
rule for your egress IP).

**1. Check it from your laptop first** (Python 3.12 `.venv`, `pip install -r db/requirements.txt`):

```bash
export STORE=azure AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=<acct>;AccountKey=<key>;EndpointSuffix=core.windows.net'
make selftest      # CAS self-test: creates container "temupuffer", writes/deletes one tiny blob
make test-azure    # 7 integration tests under itest/<random>/ (~25 MB written, then deleted)
```

Or with Entra ID instead of a key: `AZURE_STORAGE_ACCOUNT_URL=https://<acct>.blob.core.windows.net`
and `az login` (your user needs **Storage Blob Data Contributor** on the account; Owner/Contributor
alone is not enough for data-plane access).

**2. Run it on K3s.** The image needs version 0.1.2+ (0.1.1 has no Azure SDK). Add the
`azure-blob` component and drop `bundled-s3`:

```yaml
# deploy/overlays/<yours>/kustomization.yaml
resources: [namespace.yaml, ../../base]
components:
  - ../../components/azure-blob
  - ../../components/console-ingress   # optional
```

```bash
kubectl -n <ns> create secret generic temupuffer-azure \
  --from-literal=AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net'
kubectl -n <ns> create secret generic temupuffer-api --from-literal=API_KEY="tpuf-$(openssl rand -hex 16)"
kubectl apply -k deploy/overlays/<yours>
kubectl -n <ns> logs statefulset/temupuffer-query | grep selftest   # 5 lines ending "(ok)"
```

Local emulator: `make azurite-up`, then `AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true`.

**3. Or run both side by side and switch in the console.** Deploy a second stack (query + indexer,
no console) in its own namespace with the `azure-blob` component, then set `BACKENDS` on the
console (format in `db/ui/backends.sh`). My homelab does exactly this: `make homelab-apply` applies
`overlays/agathla` (SILO + console) and, if `.env.azure` exists, `overlays/agathla-azure`
(namespace `temupuffer-azure`, its Secret `temupuffer-azure` made from `.env.azure` and a copy of the
`temupuffer-api` key). Each store keeps its own namespaces; switching changes which stack you see.
(My Azure stack is scaled to 0 right now, until I recreate the storage account.)

## Durability test on a cluster

I run it from inside the cluster, so requests spread over both query pods, and delete one pod mid-run:

```bash
KEY=$(kubectl -n temupuffer get secret temupuffer-api -o jsonpath='{.data.API_KEY}' | base64 -d)
IMG=$(kubectl -n temupuffer get statefulset temupuffer-query -o jsonpath='{.spec.template.spec.containers[0].image}')
( sleep 12; kubectl -n temupuffer get pods -l app.kubernetes.io/name=temupuffer-query -o name | head -1 \
    | xargs kubectl -n temupuffer delete --wait=false ) &
kubectl -n temupuffer run durability --image="$IMG" --restart=Never -i --rm --env="TEMUPUFFER_API_KEY=$KEY" \
  -- python - --url http://temupuffer-query:8080 --seconds 30 < scripts/durability.py
```

## Publishing images for other people

`./deploy/k3s.sh install` builds from source, so nothing has to be published. To let people skip
the build, push public multi-arch images (`REGISTRY=ghcr.io/<you> ./deploy/build-images.sh push`,
then make the packages public) and tell them `./deploy/k3s.sh install --registry ghcr.io/<you> --no-build`.
