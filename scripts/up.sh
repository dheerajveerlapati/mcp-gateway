#!/usr/bin/env bash
# Brings up the whole platform on a local k3d cluster. Safe to re-run.
# Usage: ./scripts/up.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=${CLUSTER:-mcp-gateway} # override to try a second, throwaway cluster

# k3d runs k3s (the same Kubernetes as the VPS) inside Docker.
# Host ports 80/443 go to Traefik, the ingress controller bundled with k3s.
if ! k3d cluster get "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster create "$CLUSTER" -p "80:80@loadbalancer" -p "443:443@loadbalancer" --wait
fi

# build_image <service>: builds services/<service>, loads it into k3d and
# sets TAG. The tag is a hash of the source, so a code change means a new
# tag and Helm rolls the pods; no change means nothing restarts.
# (It sets TAG instead of printing it: inside $(...) a failed build would
# not stop the script.)
build_image() {
  local service=$1
  TAG=$(git ls-files -co --exclude-standard "services/$service" | sort | xargs cat | sha1sum | cut -c1-12)
  if ! docker image inspect "$service:$TAG" >/dev/null 2>&1; then
    docker build -t "$service:$TAG" "services/$service"
  fi
  k3d image import "$service:$TAG" -c "$CLUSTER"
}

./scripts/secrets.sh

helm upgrade --install store charts/store --namespace store \
  -f charts/store/values-local.yaml --wait --timeout 15m

build_image woo-mcp
WOO_TAG=$TAG
helm upgrade --install woo-mcp charts/mcp-server --namespace mcp \
  -f charts/mcp-server/values-woo.yaml -f charts/mcp-server/values-local.yaml \
  --set image.tag="$WOO_TAG" --wait --timeout 5m

build_image utils-mcp
UTILS_TAG=$TAG
helm upgrade --install utils-mcp charts/mcp-server --namespace mcp \
  -f charts/mcp-server/values-utils.yaml -f charts/mcp-server/values-local.yaml \
  --set image.tag="$UTILS_TAG" --wait --timeout 5m

build_image gateway
GATEWAY_TAG=$TAG
build_image dashboard
DASHBOARD_TAG=$TAG
# --force-conflicts: the Helm values are the source of truth, even if someone
# changed a field by hand (e.g. kubectl scale), which would otherwise block this.
helm upgrade --install gateway charts/gateway --namespace gateway --force-conflicts \
  -f charts/gateway/values-local.yaml \
  --set gateway.image.tag="$GATEWAY_TAG" --set dashboard.image.tag="$DASHBOARD_TAG" \
  --wait --timeout 5m

echo
echo "Storefront: http://store.localtest.me"
echo "  wp-admin user 'admin', password:"
echo "  kubectl -n store get secret store-secrets -o jsonpath='{.data.wp-admin-password}' | base64 -d"
echo "Dashboard:  http://dashboard.localtest.me   MCP endpoint: http://dashboard.localtest.me/mcp"
echo "  user 'admin@example.com', password:"
echo "  kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.admin-password}' | base64 -d"
