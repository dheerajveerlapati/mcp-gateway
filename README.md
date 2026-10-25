# WooCommerce hosting with a Team MCP Gateway, on Kubernetes

One WooCommerce store, an MCP server we wrote for it, and a **team MCP gateway**:
an admin registers MCP servers once in a dashboard, and every team member uses
all of their tools through **one URL and their own API key**, from Claude Code /
Cursor / MCP Inspector, or from a chat agent in the dashboard.

Everything runs on Kubernetes and installs with Helm. The same charts run on a
laptop (k3d) and on a VPS (k3s); only the values files differ.

- [System design and tradeoffs](docs/design.md)
- [Threat model](docs/threat-model.md)

## What runs where

```
                 Ingress (Traefik, ships with k3s)
  store.localtest.me ──┐                 ┌── dashboard.localtest.me
                       │                 │     /      -> dashboard (React, nginx)
                       │                 │     /api   -> gateway (dashboard API, chat)
                       │                 │     /mcp   -> gateway (MCP endpoint)
 ns store              ▼                 ▼                                ns gateway
 ┌──────────────────────────┐   ┌──────────────────────────────────┐   ┌──────────┐
 │ WordPress + WooCommerce  │   │ gateway (FastAPI)                 │──▶│ Postgres │
 │ (PVC: site files)        │   │  - MCP server  (/mcp)             │   │  (PVC)   │
 │ MariaDB (PVC)            │   │  - MCP client of every upstream   │   └──────────┘
 └───────────▲──────────────┘   │  - chat agent (deepagents + LLM)  │
             │ REST API         └──────┬──────────────┬──────────────┘
 ns mcp      │ (OAuth 1.0a)            │ bearer token │ bearer token      HTTPS + token
 ┌───────────┴──────────┐   ┌──────────▼───┐   ┌──────▼────────┐   ┌──────────────────┐
 │ woo-mcp (ours)       │◀──┘              │   │ utils-mcp     │   │ GitHub MCP       │
 │ products and orders  │                  │   │ (ours)        │   │ (hosted by GitHub)│
 └──────────────────────┘                  │   └───────────────┘   └──────────────────┘
```

| Namespace | Workloads | Public? |
|---|---|---|
| `store` | WordPress + WooCommerce (Deployment), MariaDB (StatefulSet), setup Job | Storefront only, via Ingress |
| `mcp` | `woo-mcp`, `utils-mcp` | **No.** ClusterIP only, NetworkPolicy allows only gateway pods |
| `gateway` | gateway, dashboard, Postgres (StatefulSet) | `/`, `/api`, `/mcp` via Ingress; Postgres is internal |

## Local setup (k3d)

**Needs:** Docker (about 8 GB RAM for Docker), [k3d](https://k3d.io) 5.x, kubectl,
Helm 3.8+ (tested with Helm 4.3), git, openssl and bash. On Windows use Git Bash.

```bash
git clone <this repo> && cd mcp-gateway
./scripts/up.sh
```

`up.sh` is safe to re-run. It:
1. creates a k3d cluster `mcp-gateway` with host ports 80/443 mapped to Traefik,
2. creates every Kubernetes Secret with random values (`scripts/secrets.sh`; nothing secret is in git),
3. installs the `store` chart and waits for the WooCommerce setup Job,
4. builds the images (`woo-mcp`, `utils-mcp`, `gateway`, `dashboard`), imports them into k3d,
   and installs the `mcp-server` chart twice and the `gateway` chart.

First run takes about 10 minutes (image pulls plus the WooCommerce download).

**Chat agent key (optional; everything else works without it).** Create a free key at
<https://console.groq.com/keys>, then:

```bash
read -s -p "LLM API key: " K && kubectl -n gateway create secret generic llm-secrets --from-literal=api-key="$K"
kubectl -n gateway rollout restart deploy/gateway
```

To use Gemini instead, set `llm.provider: google_genai` and `llm.model: gemini-3.5-flash`
in `charts/gateway/values.yaml` (a config change, not a code change).

### Local domains

`*.localtest.me` is a public DNS name that always resolves to `127.0.0.1`. k3d maps
ports 80/443 on your machine to Traefik in the cluster, so
`http://store.localtest.me` and `http://dashboard.localtest.me` work with **no hosts-file
edits** on Windows, macOS or Linux.

### Logins

| What | URL | User | Password |
|---|---|---|---|
| Storefront | http://store.localtest.me | - | - |
| WooCommerce admin | http://store.localtest.me/wp-admin | `admin` | `kubectl -n store get secret store-secrets -o jsonpath='{.data.wp-admin-password}' \| base64 -d` |
| Dashboard | http://dashboard.localtest.me | `admin@example.com` | `kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.admin-password}' \| base64 -d` |

### Register the other upstream servers

The WooCommerce MCP server is registered automatically on first start. Add the
other two in **Dashboard -> Servers -> Add server**:

| Name | URL | Auth | Credential |
|---|---|---|---|
| `utils` | `http://utils-mcp.mcp:8000/mcp` | Bearer | `kubectl -n mcp get secret utils-mcp-secrets -o jsonpath='{.data.mcp-token}' \| base64 -d` |
| `github` | `https://api.githubcopilot.com/mcp/x/issues` | Bearer | a GitHub fine-grained token, limited to **one** repo, **Issues: read and write** |

The `/x/issues` URL loads only GitHub's issue tools (10 instead of dozens), which
keeps prompts small for free-tier LLMs.

## How to use it

### Place an order
Open http://store.localtest.me, add a product to the cart, check out with
**Cash on delivery**. The order appears in **wp-admin -> WooCommerce -> Orders**.

### Connect an external MCP client
1. Dashboard -> **API keys** -> create a key. It is shown once.
2. Add the gateway to your client. The dashboard shows the exact command:
   ```bash
   claude mcp add --transport http mcp-gateway http://dashboard.localtest.me/mcp \
     --header "Authorization: Bearer mgw_..."
   ```
   **MCP Inspector:** `npx @modelcontextprotocol/inspector`, transport
   *Streamable HTTP*, URL `http://dashboard.localtest.me/mcp`, header
   `Authorization: Bearer mgw_...`.
3. You see the tools of every enabled server, named `<server>__<tool>`,
   e.g. `woo__list_orders`, `utils__convert_currency`, `github__issue_write`.

### Use the chat agent
Dashboard -> **Chat**. Try *"Create a product called Blue Mug with price 499"* or
*"What orders came in today? Show the totals in USD."* Each tool call is shown with
its arguments and result, and appears in the **Audit log** under your name.

### Team
**Team** (admins): invite people by one-time link, change roles, remove people,
issue or revoke their keys. **Account**: change your password.

## Definition-of-done walkthrough

| Step | How |
|---|---|
| Store order | Storefront -> COD checkout -> visible in wp-admin |
| Chat as user A | *"Create a product called Blue Mug with price 499"* -> on the storefront; order it by hand; *"What orders came in today?"* |
| External client as user B | Invite B, B creates a key, connect MCP Inspector or Claude Code with only URL + key; ask the orders question; *"List today's orders with totals in USD"* (woo + utils) |
| Revoke B's key | Team -> B -> Keys -> Revoke. B's next request gets 401 and an audit row `denied` |
| Disable a server | Servers -> Disable. Its tools vanish from the chat (tools are fetched per message) and from the external client on its next tool list |
| Kill an upstream pod | `kubectl -n mcp scale deploy/utils-mcp --replicas=0` (or delete the pod and watch: the Deployment restarts it within seconds). Dashboard shows `unreachable` with the reason; the other servers keep working |
| Audit | Audit log page: every call above, with user, via (API key / chat), server, tool, time, duration, outcome |

Useful extra demos: `utils__slow_task` with `seconds: 30` shows the 15 s timeout;
`woo__ping` and `utils__ping` show the name-collision scheme.

## Production-like setup (VPS with k3s)

The same charts; differences live only in `values-prod.yaml` files.

1. **Server.** Any Linux VM with 4 GB+ RAM. Open ports 80 and 443 (on Oracle Cloud:
   both the VCN security list and the instance firewall).
2. **k3s** (includes Traefik, local-path storage and NetworkPolicy enforcement):
   ```bash
   curl -sfL https://get.k3s.io | sh -
   export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
   ```
3. **DNS.** Point `store.<domain>` and `dashboard.<domain>` at the VPS IP (A records).
4. **TLS with cert-manager:**
   ```bash
   helm install cert-manager oci://quay.io/jetstack/charts/cert-manager \
     -n cert-manager --create-namespace --set crds.enabled=true
   kubectl apply -f - <<'EOF'
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata: { name: letsencrypt-prod }
   spec:
     acme:
       server: https://acme-v02.api.letsencrypt.org/directory
       email: you@example.com
       privateKeySecretRef: { name: letsencrypt-prod }
       solvers: [{ http01: { ingress: { ingressClassName: traefik } } }]
   EOF
   ```
5. **Images.** Build for the VPS CPU and push to GHCR (ARM VMs like Oracle's free
   tier need `linux/arm64`):
   ```bash
   for s in woo-mcp utils-mcp gateway dashboard; do
     docker buildx build --platform linux/amd64,linux/arm64 \
       -t ghcr.io/<owner>/$s:0.1.0 --push services/$s
   done
   ```
6. **Values.** In the four `values-prod.yaml` files replace `example.com` with your
   domain and `ghcr.io/OWNER` with your registry. (Make the GHCR packages public, or add
   an `imagePullSecret`.)
7. **Secrets and install:**
   ```bash
   ./scripts/secrets.sh
   kubectl -n gateway create secret generic llm-secrets --from-literal=api-key=...
   helm upgrade --install store charts/store -n store -f charts/store/values-prod.yaml --wait --timeout 15m
   helm upgrade --install woo-mcp charts/mcp-server -n mcp \
     -f charts/mcp-server/values-woo.yaml -f charts/mcp-server/values-prod.yaml --wait
   helm upgrade --install utils-mcp charts/mcp-server -n mcp \
     -f charts/mcp-server/values-utils.yaml -f charts/mcp-server/values-prod.yaml --wait
   helm upgrade --install gateway charts/gateway -n gateway -f charts/gateway/values-prod.yaml --wait
   ```

**What changes between local and prod (values only):**

| | Local (`values-local.yaml`) | Prod (`values-prod.yaml`) |
|---|---|---|
| Hostnames | `*.localtest.me` | real DNS names |
| TLS | off | on, cert-manager + Let's Encrypt |
| Images | built locally, `pullPolicy: Never` | `ghcr.io/<owner>/...:0.1.0` |
| Replicas | 1 | gateway 2, MCP servers 2, dashboard 2 |
| Storage | 1-2 Gi, `local-path` | 5-10 Gi (set `storageClass` for a cloud disk) |
| Resources | small | larger requests and limits |
| Secrets | `scripts/secrets.sh` | same script, or an external secret manager |

## Upgrades and rollback

Each component is its own Helm release (`store`, `woo-mcp`, `utils-mcp`, `gateway`),
so each upgrades and rolls back independently.

```bash
helm history gateway -n gateway             # every revision with its status
helm upgrade gateway charts/gateway -n gateway -f charts/gateway/values-prod.yaml \
  --set gateway.image.tag=0.2.0 --wait      # new version
helm rollback gateway 3 -n gateway --wait   # back to revision 3
```

- **Store:** bump `wordpress.image` / `setup.woocommerceVersion` and `helm upgrade`. The
  setup Job runs after every upgrade, installs the pinned WooCommerce version and runs
  `wp wc update` (database migrations). Back up MariaDB first: plugin database
  migrations are not undone by a Helm rollback.
- **Gateway:** database migrations run in an init container (`alembic upgrade head`)
  before the new version starts. Rule for new migrations: only additive changes (new
  tables or nullable columns) in a release, so the previous image still works after a
  `helm rollback`. To undo a schema change explicitly, run `alembic downgrade -1` in the
  gateway pod (every migration has a `downgrade()`).
- **MCP servers:** stateless, so upgrade and rollback are just image changes.

## Repository layout

```
charts/
  store/        WordPress + WooCommerce + MariaDB, WP-CLI setup Job, Ingress, NetworkPolicies
  mcp-server/   one reusable chart for an internal MCP server (installed as woo-mcp and utils-mcp)
  gateway/      gateway + Postgres + dashboard, Ingress, NetworkPolicies
services/
  woo-mcp/      our WooCommerce MCP server (Python, MCP SDK)
  utils-mcp/    helper MCP server: currency, shipping, time, ping, slow_task
  gateway/      FastAPI: dashboard API, /mcp aggregator, chat agent, migrations
  dashboard/    React + Vite + TypeScript
scripts/
  up.sh         one-command local setup
  secrets.sh    creates the Kubernetes Secrets with random values
docs/
  design.md, threat-model.md
```

## Stand-out items attempted

| Item | What is done | Where |
|---|---|---|
| 6. Security hardening (partial) | NetworkPolicies for every workload, with egress allow-lists for the MCP servers, gateway, dashboard and Postgres; our containers run as non-root with read-only root filesystems and no service-account token; upstream credentials encrypted at rest (Fernet); the gateway cannot reach private address ranges except its DB and the `mcp` namespace (network-level SSRF guard) | `charts/*/templates/networkpolicy.yaml`, `charts/*/templates/*.yaml`, `services/gateway/app/security.py` |
| 7. Scaling (partial) | `/mcp` is stateless, so any replica serves any request; prod values run 2 gateway replicas; concurrent migrations are serialised with a Postgres advisory lock. No rate limiting yet | `services/gateway/app/mcp_gateway.py`, `migrations/env.py` |
| 8. Observability (partial) | the dashboard shows why an upstream is unreachable (timeout, connection refused, credential rejected with HTTP status) and every failed call's reason is in the audit log. No metrics endpoint | `services/gateway/app/upstreams.py` |
| 9. Upgrades and rollback | one Helm release per component, migrations in an init container, documented above | this README |
| 1. VPS deployment | charts and prod values ready, steps above | `values-prod.yaml` files |

Not attempted: multi-store bonus, tool permissions per role, OAuth, many-tools search,
hosted MCP servers by image.
