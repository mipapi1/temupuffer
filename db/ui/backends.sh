#!/bin/sh
# Runs at container start (nginx's /docker-entrypoint.d/), before the envsubst
# step. Builds the routing to the query nodes.
#
# Namespace affinity: every request for one namespace goes to the same query
# node, chosen by a consistent hash of the namespace name. turbopuffer routes a
# namespace to the same node so that node's cache stays warm, and so do we.
# It's a preference, not a lock. If that node is down, nginx moves on to the
# next node on the ring. Two nodes can still write the same namespace, e.g.
# while the ring changes, and the WAL's conditional PUTs keep that correct.
#
# Inputs:
#   QUERY_RING   the query nodes, host:port joined with '+', ONE ENTRY PER POD:
#                  temupuffer-query-0.temupuffer-query-peers:8080+temupuffer-query-1.temupuffer-query-peers:8080
#                Don't use a name that resolves to several pods (a Service):
#                nginx places servers on the ring by NAME, so pods behind one
#                name would share a position. List every replica; scaling the
#                StatefulSet means updating this list.
#                Empty: QUERY_UPSTREAM (one name, so no affinity).
#   BACKENDS     extra stacks for the console's Storage picker (other object stores):
#                  id|label|ring[,id|label|ring...]     ring = host:port[+host:port...]
#
# On Kubernetes, short names (without ".svc.") get the pod's own namespace
# appended (the first resolv.conf search domain), because nginx's resolver
# doesn't apply search domains. Names are re-resolved every 10 s, so a pod that
# restarts with a new IP keeps its place on the ring.
#
# Writes:
#   /etc/nginx/conf.d/00-ring.conf   http level: resolver, the $tp_ns key, one upstream per stack
#   /etc/nginx/conf.d/backends.inc   server level: /b/<id>/api/ routes and /backends.json
set -eu
ring_conf=/etc/nginx/conf.d/00-ring.conf
out=/etc/nginx/conf.d/backends.inc
ns=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)
case "$ns" in *:*) ns="[$ns]" ;; esac
search=$(awk '/^search/ {print $2; exit}' /etc/resolv.conf)

# host:port -> the full DNS name on Kubernetes; unchanged elsewhere (compose).
fqdn() {
  host=${1%:*}
  port=${1##*:}
  case "$host" in
    *.svc.*|*.svc) ;;
    *) case "$search" in *.svc.*) host="$host.$search" ;; esac ;;
  esac
  printf '%s:%s' "$host" "$port"
}

# ring_upstream NAME MEMBERS: appends a consistent-hash upstream to 00-ring.conf.
ring_upstream() {
  name=$1
  members=$2
  [ -n "$members" ] || { echo "backends.sh: upstream $name has no servers" >&2; exit 1; }
  {
    echo "upstream $name {"
    echo "    zone $name 64k;"
    echo "    hash \$tp_ns consistent;"
    saved_ifs=$IFS
    IFS='+'
    for m in $members; do
      [ -n "$m" ] && echo "    server $(fqdn "$m") resolve;"
    done
    IFS=$saved_ifs
    echo "}"
  } >> "$ring_conf"
}

cat > "$ring_conf" <<EOF
resolver $ns valid=10s ipv6=off;

# The hash key: the namespace name from /v1|v2/namespaces/<name>/... Requests
# without one (listing namespaces, /debug) get a random key, so they spread.
map \$uri \$tp_ns {
    "~/namespaces/(?<tp_ns_name>[^/]+)"  \$tp_ns_name;
    default                               \$request_id;
}

EOF
default_ring=${QUERY_RING:-${QUERY_UPSTREAM:-}}
ring_upstream tp_ring_default "$default_ring"
echo "backends.sh: default ring: $default_ring"

json='[{"id":"default","label":"Default","prefix":"/api"}]'
: > "$out"
if [ -n "${BACKENDS:-}" ]; then
  json='['
  sep=''
  old_ifs=$IFS
  IFS=','
  for entry in $BACKENDS; do
    IFS='|' read -r id label ring <<EOF
$entry
EOF
    case "$id" in ''|*[!a-z0-9-]*) echo "backends.sh: bad backend id '$id'" >&2; exit 1 ;; esac
    label=$(printf '%s' "$label" | tr -d "'\"\\\\")
    up=$(printf 'tp_ring_%s' "$id" | tr '-' '_')
    ring_upstream "$up" "$ring"
    cat >> "$out" <<EOF
location /b/$id/api/ {
    proxy_pass http://$up/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host \$host;
    proxy_read_timeout 120s;
    proxy_next_upstream error timeout;
    proxy_next_upstream_tries 2;
    add_header X-Temupuffer-Route-Key \$tp_ns always;
    add_header X-Temupuffer-Upstream \$upstream_addr always;
}
EOF
    json="$json$sep{\"id\":\"$id\",\"label\":\"$label\",\"prefix\":\"/b/$id/api\"}"
    sep=','
  done
  IFS=$old_ifs
  json="$json]"
fi
cat >> "$out" <<EOF
location = /backends.json {
    default_type application/json;
    add_header Cache-Control "no-cache";
    return 200 '$json';
}
EOF
echo "backends.sh: $json"
