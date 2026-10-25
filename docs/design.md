# System design and tradeoffs

## Components

| Component | Responsibility | Tech |
|---|---|---|
| Store | WordPress + WooCommerce, MariaDB. A WP-CLI Job installs WooCommerce, enables Cash on delivery and registers the REST API key from a Secret | Official `wordpress` / `mariadb` images, our Helm chart |
| woo-mcp | Our MCP server: `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status`, `ping` | Python, MCP SDK 2.3 (`MCPServer`), httpx |
| utils-mcp | Second in-cluster upstream: `convert_currency`, `shipping_quote`, `current_time`, `ping`, `slow_task` | same |
| GitHub MCP | Third upstream, hosted by GitHub, bearer token | external |
| gateway | Dashboard API, team and keys, upstream registry and health checks, the `/mcp` endpoint, audit log, chat agent | FastAPI, SQLAlchemy, Postgres, MCP SDK, deepagents |
| dashboard | Servers, Team, API keys, Audit log, Chat, Account | React + Vite + TypeScript, nginx |

## Architecture choices

**k3d locally, k3s on the VPS.** k3d is k3s in Docker, so both environments have the
same ingress controller (Traefik), storage class (`local-path`) and NetworkPolicy
enforcement. The values files only differ in hostnames, TLS, image registry, replicas,
storage and resources.

**One Helm release per component.** `store`, `woo-mcp`, `utils-mcp`, `gateway` live in
their own namespaces and upgrade and roll back independently. Both internal MCP servers
use the same `mcp-server` chart with different values files, so their Deployment,
Service, probes and NetworkPolicy are written once.

**Our own store chart instead of a packaged one.** The official images plus about 300
lines of templates, so every resource is understood. MariaDB is a StatefulSet with a
volume claim template; WordPress keeps its whole site directory on a PVC and uses the
`Recreate` strategy, because a ReadWriteOnce volume can only be mounted by one pod.

**How woo-mcp talks to the store: the WooCommerce REST API.**
- *Not WP-CLI:* it would need `kubectl exec` rights into the WordPress pod or a shared
  volume. That means Kubernetes API permissions and tight coupling to the pod.
- *Not SQL:* writing to the database directly skips WooCommerce's own logic (stock,
  hooks, order tables).
- *REST:* a versioned contract, input validation, an API key with its own permissions,
  and the only coupling is one network connection that a NetworkPolicy can describe.

Inside the cluster the call is plain HTTP, and on plain HTTP WooCommerce refuses the key
as a password and requires **OAuth 1.0a signatures**. We sign every request with
HMAC-SHA256, so the consumer secret never crosses the network. WooCommerce checks the
signature against the shop's public home URL, not the internal address, so the client
reads the home URL from `/wp-json/` once and signs with that
(`services/woo-mcp/app/woo_client.py`).

**The gateway's own Postgres.** Users, API keys, servers and the audit log. It is
separate from the store's MariaDB so the two fail, scale and upgrade independently.
Schema changes go through Alembic migrations, run by an init container. A Postgres
advisory lock makes concurrent replicas take turns.

**Stateless MCP endpoint.** The gateway serves `/mcp` with the SDK's Streamable HTTP
session manager in *stateless + JSON response* mode. Every request carries the API key
and is complete on its own, so any replica can answer it and a revoked key fails on the
very next request. Tradeoff: without a session the server cannot push
`notifications/tools/list_changed`; clients see a disabled server disappear on their
next `tools/list` (calls to it are refused immediately either way).

## How tool aggregation, routing and failure handling work

### Upstream health loop (`app/upstreams.py`)
Every 10 seconds the gateway checks **all servers in parallel**. For each enabled server
it opens an MCP connection with that server's credential, calls `tools/list` (following
pagination) with a 5 second limit, and remembers the result in memory:

- `connected` and its tools,
- `unreachable` and a readable reason: *no answer within 5 seconds*, *cannot connect*,
  *server rejected the credential (HTTP 401)*,
- `disabled`.

Each check and each call uses a fresh connection. That costs one extra round trip, but a
restarted or dead upstream can never leave a half-broken connection behind.

### Listing tools (`app/mcp_gateway.py`)
`tools/list` reads the enabled servers from the **database** (so disabling a server
takes effect at once on every replica) and returns the remembered tools of those that
are `connected`. Listing never waits on an upstream, so a dead or slow server cannot
slow it down; it simply contributes no tools.

### Name collisions: always prefix
Every tool is exposed as `<server>__<tool>`, e.g. `woo__ping` and `utils__ping`.
- **Always**, not only on a collision: names stay stable when another server is added
  later, and the name tells the model and the reader where the tool comes from.
- Server names are lowercase words joined by **single** underscores, so `__` is
  reserved and splitting at the first `__` is unambiguous.
- Many clients accept only `^[a-zA-Z0-9_-]{1,64}$`. Tools whose prefixed name would break
  that are hidden and listed on the Servers page as skipped.
- Descriptions are prefixed with `[server]` as well.

### Calling a tool
1. `McpEndpoint` identifies the caller before any MCP code runs: an API key (`mgw_...`,
   SHA-256 looked up in `api_keys`, must not be revoked), an OAuth access token
   (`mgo_...`, see below) or the chat agent's short-lived signed token. Otherwise 401
   (with the OAuth metadata link), and a refused key that belongs to a known user is
   audited as `denied`.
2. `call_tool` splits the name, loads the server, refuses it if disabled.
3. `upstreams.call_tool` decrypts that server's credential, connects, calls the tool with
   **one** time limit (`asyncio.timeout`, 15 s by default) around connect + call. The HTTP
   library's own timeout is switched off so there is no hidden second timer.
4. Every outcome becomes a normal MCP tool result the model can read: the upstream's
   result, or `is_error` with a sentence like *"Server 'utils' failed: no answer within
   15 seconds"*.
5. An audit row is written: user, source (`api_key`, `oauth` or `chat`), server, tool,
   time, duration, outcome (`ok`, `error`, `timeout`, `denied`) and the error text. A
   failure to write the audit row is logged and never breaks the call.

Before step 3 two more checks run, in this order: **permissions** and the **rate limit**.

### Tool permissions (`app/permissions.py`)
Tools the upstream marks read-only (`readOnlyHint`) are for everyone; any other tool may
change something, so it is admin-only by default. Admins override per tool (stored in
`tool_permissions`). A caller's `tools/list` hides what they may not use, and
`tools/call` checks again, because a client can call a tool by name without being shown
it. An unknown tool (server not reachable yet) gets the safe default.

### Rate limit
Each user may make `rateLimitPerMinute` tool calls per minute (60 by default). The count
comes from the audit log in Postgres (`user_id, created_at` index), so it is one limit
across all gateway replicas, not one per pod.

### Many tools: search mode (`app/tool_search.py`)
`/mcp?tools=search` lists only `gateway__search_tools(query)` and
`gateway__call_tool(name, arguments)`. Search ranks the caller's permitted tools by
keyword matches (name x2, description x1) and returns names, descriptions and argument
schemas; call goes through exactly the same routing, permissions, rate limit and audit.
The chat agent switches to this mode when a user has more than 30 tools, so the model
sees two tool definitions instead of hundreds.

### Several replicas
Upstream status lives in each replica's memory. Two rules keep replicas correct:
- `/readyz` stays 503 until the replica's first full upstream check, so Kubernetes sends
  it no traffic while it knows no tools.
- If the database says a server is enabled but this replica remembers it as disabled or
  unknown (an admin just enabled it through another replica), it re-checks that server
  before answering.

Verified with two replicas: the end-to-end check passes repeatedly with calls spread over
both pods.

### Hosted MCP servers (`app/hosting.py`)
An admin can add a server by container image. The gateway writes four objects to the
`mcp-hosted` namespace with server-side apply (one idempotent call each, safe to retry):
a Secret (the admin's environment variables plus a random `MCP_TOKEN`), a Deployment
(non-root, read-only root filesystem, CPU/memory limits, no service-account token, TCP
probes), a Service, and a NetworkPolicy (in: only gateway pods; out: DNS and public
HTTPS). It then registers `http://mcp-<name>.mcp-hosted:<port>/mcp` with that token.
Removing the server deletes the four objects. The namespace has a ResourceQuota, a
LimitRange and a default-deny policy; the gateway's Role allows only these four kinds in
only this namespace.

### OAuth for MCP clients (`app/routes/oauth.py`)
Implements the MCP authorization spec so a client can log in through the browser instead
of using a pasted key: a 401 from `/mcp` carries `resource_metadata`; the client reads the
protected-resource and authorization-server metadata, registers itself, sends the user to
`/oauth/authorize` -> the dashboard consent page, and exchanges the one-time code (PKCE
S256) for a 1-hour access token and a rotating 30-day refresh token. Tokens are stored as
SHA-256 and can be disconnected per app. Written by hand rather than with the SDK's
helpers because those reject a non-HTTPS issuer, and the local setup is plain HTTP.

### Chat agent (`app/agent.py`)
The chat is **another MCP client of the gateway**, not a shortcut:
1. The gateway mints a 10-minute token for the logged-in user (audience `mcp-chat`).
2. The agent connects to the gateway's own `/mcp` with it and lists the tools (per
   message, so a just-disabled server is already gone).
3. Each MCP tool is wrapped as a LangChain tool by a small adapter (the
   `langchain-mcp-adapters` package requires MCP SDK < 2).
4. A deepagents agent runs the loop: model -> tool calls -> results -> model -> answer.
   Its built-in file, shell and sub-agent tools are switched off (hidden from the model
   and rejected if called): it acts only through the gateway.
5. The steps stream to the browser as Server-Sent Events: each tool call, its result,
   the answer.

Its calls therefore pass the same checks and land in the audit log under the user, with
source `chat`. The provider is a Helm value (`groq` by default, or `google_genai`), so a
rate-limited provider is swapped by configuration. The browser keeps the conversation;
the server stores no chat history.

## What changes for production

| Concern | Local | Production |
|---|---|---|
| **DNS** | `*.localtest.me` -> 127.0.0.1 | A records for `store.<domain>`, `dashboard.<domain>` -> VPS IP |
| **Ingress** | Traefik, HTTP, ports mapped by k3d | Traefik, HTTPS; cert-manager issues Let's Encrypt certificates (`cert-manager.io/cluster-issuer` annotation from values) |
| **Storage class** | `local-path` (node disk) | `local-path` on a single-node k3s; on a multi-node or cloud cluster set `storageClass` to a network disk; back up the MariaDB and Postgres volumes |
| **Secrets** | `scripts/secrets.sh` generates them in the cluster | same script, or an external secret manager (Sealed Secrets, External Secrets). Turn on k3s secrets encryption (`--secrets-encryption`) so Secrets are encrypted in etcd |
| **Images** | built and imported into k3d | multi-arch images in GHCR, pinned tags |
| **Replicas** | 1 | gateway, MCP servers and dashboard 2 each (set in values, not with `kubectl scale`) |
| **Kubernetes API egress** | k3s defaults (`10.43.0.1:443`, API server on `6443`) | adjust `hosted.apiServerEgress` if the cluster uses other addresses |
| **Cookies** | `Secure` off (plain HTTP) | `Secure` on automatically when `PUBLIC_URL` is https |

## Known limitations

- The store is a single WordPress pod on a ReadWriteOnce volume. Scaling it needs shared
  storage (or plugins baked into the image and uploads on object storage), a Redis object
  cache, and a replicated or managed MariaDB. The gateway protects it with timeouts and
  page limits (at most 50 items per list call).
- Upstream status is kept in each gateway replica's memory, so for up to one health-check
  interval (10 s) two replicas may show a different status for a server that just died.
  The enabled/disabled flag always comes from the database.
- No push of `tools/list_changed` (stateless mode, see above).
- Tool permissions are per role (admin / member), not per individual user.
- Admin actions on servers and members are not in the audit log; tool calls are.
- Hosted servers must run as a non-root user (uid 10001 is forced) and listen on a port
  of 1024 or above.
- Invites are links shown to the admin, not emails.
