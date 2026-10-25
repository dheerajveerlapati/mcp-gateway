#!/usr/bin/env bash
# Creates the Kubernetes Secrets the charts expect, with random values.
# Safe to re-run: existing Secrets are kept, so passwords never change by accident.
# Secret values exist only inside the cluster - never in git or in Helm values.
set -euo pipefail

random() { openssl rand -hex "$1"; }

# read_secret <namespace> <name> <key>  -> prints the decoded value
read_secret() {
  kubectl -n "$1" get secret "$2" -o jsonpath="{.data.$3}" | base64 -d
}

# ensure_secret <namespace> <name> key=value...
ensure_secret() {
  local namespace=$1 name=$2
  shift 2
  kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  if kubectl -n "$namespace" get secret "$name" >/dev/null 2>&1; then
    echo "Secret $namespace/$name exists, keeping it"
    return
  fi
  local args=()
  for pair in "$@"; do args+=("--from-literal=$pair"); done
  kubectl -n "$namespace" create secret generic "$name" "${args[@]}"
}

# Store: database passwords, wp-admin password, WooCommerce REST API key.
ensure_secret store store-secrets \
  "db-root-password=$(random 16)" \
  "db-password=$(random 16)" \
  "wp-admin-password=$(random 12)" \
  "woo-consumer-key=ck_$(random 20)" \
  "woo-consumer-secret=cs_$(random 20)"

# WooCommerce MCP server: the same store API key (Secrets can't be shared
# across namespaces, so it gets its own copy) plus the token the gateway
# must send to call it.
ensure_secret mcp woo-mcp-secrets \
  "woo-consumer-key=$(read_secret store store-secrets woo-consumer-key)" \
  "woo-consumer-secret=$(read_secret store store-secrets woo-consumer-secret)" \
  "mcp-token=$(random 24)"

# Shop Utils MCP server: only the token the gateway must send.
ensure_secret mcp utils-mcp-secrets "mcp-token=$(random 24)"

# Gateway: its database password, the key that signs login sessions, the key
# that encrypts upstream credentials (Fernet format: 32 random bytes,
# url-safe base64), the first admin's password, and the tokens it uses to
# call our two MCP servers.
ensure_secret gateway gateway-secrets \
  "db-password=$(random 16)" \
  "session-secret=$(random 32)" \
  "encryption-key=$(openssl rand -base64 32 | tr '+/' '-_')" \
  "admin-password=$(random 12)" \
  "woo-mcp-token=$(read_secret mcp woo-mcp-secrets mcp-token)" \
  "utils-mcp-token=$(read_secret mcp utils-mcp-secrets mcp-token)"
