#!/usr/bin/env bash
# Brings up the whole platform on a local k3d cluster. Safe to re-run.
# Usage: ./scripts/up.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=mcp-gateway

# k3d runs k3s (the same Kubernetes as the VPS) inside Docker.
# Host ports 80/443 go to Traefik, the ingress controller bundled with k3s.
if ! k3d cluster get "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster create "$CLUSTER" -p "80:80@loadbalancer" -p "443:443@loadbalancer" --wait
fi

# build_image <service>: builds services/<service> and loads it into k3d.
# The tag is a hash of the source, so a code change means a new tag and
# Helm rolls the pods; no change means nothing restarts.
build_image() {
  local service=$1
  local tag
  tag=$(git ls-files -co --exclude-standard "services/$service" | sort | xargs cat | sha1sum | cut -c1-12)
  if ! docker image inspect "$service:$tag" >/dev/null 2>&1; then
    docker build -t "$service:$tag" "services/$service"
  fi
  k3d image import "$service:$tag" -c "$CLUSTER" >/dev/null
  echo "$tag"
}

./scripts/secrets.sh

helm upgrade --install store charts/store --namespace store \
  -f charts/store/values-local.yaml --wait --timeout 15m

WOO_TAG=$(build_image woo-mcp | tail -1)
helm upgrade --install woo-mcp charts/mcp-server --namespace mcp \
  -f charts/mcp-server/values-woo.yaml -f charts/mcp-server/values-local.yaml \
  --set image.tag="$WOO_TAG" --wait --timeout 5m

UTILS_TAG=$(build_image utils-mcp | tail -1)
helm upgrade --install utils-mcp charts/mcp-server --namespace mcp \
  -f charts/mcp-server/values-utils.yaml -f charts/mcp-server/values-local.yaml \
  --set image.tag="$UTILS_TAG" --wait --timeout 5m

GATEWAY_TAG=$(build_image gateway | tail -1)
helm upgrade --install gateway charts/gateway --namespace gateway \
  -f charts/gateway/values-local.yaml \
  --set gateway.image.tag="$GATEWAY_TAG" --wait --timeout 5m

echo
echo "Storefront: http://store.localtest.me"
echo "  wp-admin user 'admin', password:"
echo "  kubectl -n store get secret store-secrets -o jsonpath='{.data.wp-admin-password}' | base64 -d"
echo "Dashboard:  http://dashboard.localtest.me   MCP endpoint: http://dashboard.localtest.me/mcp"
echo "  user 'admin@example.com', password:"
echo "  kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.admin-password}' | base64 -d"
