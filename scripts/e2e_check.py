"""End-to-end check of a running installation, through the public URLs only.

It plays an admin and a member ("user B") and checks the definition-of-done
behaviour plus the extras: tool list and routing, name collisions, timeouts,
permissions, SSRF guard, disabling a server, revoking a key, rate limit and the
audit log. It leaves the system as it found it (except the test member, the
audit rows and one revoked key).

Run (after scripts/up.sh, with the utils server registered):
  ADMIN_PASSWORD=$(kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.admin-password}' | base64 -d) \
    uv run --directory services/gateway python ../../scripts/e2e_check.py [--slow]

--slow also runs the 15-second timeout and the 60-call rate-limit checks.
"""

import asyncio
import os
import sys
import time

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

BASE = os.environ.get("GATEWAY_URL", "http://dashboard.localtest.me")
MEMBER = {"email": "e2e-member@example.com", "name": "E2E Member", "password": "e2e-member-pass"}
failures = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        failures.append(name)


def login(email: str, password: str) -> httpx2.Client:
    client = httpx2.Client(base_url=BASE, timeout=60)
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    response.raise_for_status()
    return client


def member_session(admin: httpx2.Client) -> httpx2.Client:
    """Log in as the test member, inviting them first if needed."""
    try:
        return login(MEMBER["email"], MEMBER["password"])
    except httpx2.HTTPStatusError:
        invite = admin.post("/api/users", json={"email": MEMBER["email"], "name": MEMBER["name"]}).json()
        token = invite["invite_url"].rsplit("/", 1)[1]
        httpx2.post(f"{BASE}/api/auth/invites/{token}/accept", json={"password": MEMBER["password"]})
        return login(MEMBER["email"], MEMBER["password"])


async def mcp(key: str, action):
    """Open an MCP connection to the gateway with `key` and run `action(client)`."""
    http = httpx2.AsyncClient(headers={"Authorization": f"Bearer {key}"}, timeout=60)
    async with Client(streamable_http_client(f"{BASE}/mcp", http_client=http)) as client:
        return await action(client)


async def call(key: str, tool: str, arguments: dict | None = None) -> tuple[bool, str]:
    result = await mcp(key, lambda c: c.call_tool(tool, arguments or {}))
    text = "\n".join(part.text for part in result.content if part.type == "text")
    return not result.is_error, text


async def tool_names(key: str) -> list[str]:
    return [t.name for t in (await mcp(key, lambda c: c.list_tools())).tools]


def server_named(admin: httpx2.Client, name: str) -> dict:
    return next(s for s in admin.get("/api/servers").json() if s["name"] == name)


async def main(slow: bool) -> None:
    admin = login("admin@example.com", os.environ["ADMIN_PASSWORD"])
    member = member_session(admin)
    key = member.post("/api/keys", json={"name": "e2e check"}).json()["secret"]

    # Tool list: every enabled server, prefixed; write tools hidden from members.
    names = await tool_names(key)
    check("member sees prefixed tools from several servers",
          {"woo__list_orders", "utils__convert_currency"} <= set(names), f"{len(names)} tools")
    check("write tools hidden from members", "woo__create_product" not in names)

    # Routing and collisions.
    ok, text = await call(key, "woo__list_orders", {"date_from": time.strftime("%Y-%m-%d")})
    check("woo__list_orders is routed to the store", ok and '"count"' in text)
    ok, text = await call(key, "utils__convert_currency", {"amount": 100, "from_currency": "USD", "to_currency": "INR"})
    check("utils__convert_currency is routed to utils", ok and "INR" in text)
    _, woo_pong = await call(key, "woo__ping")
    _, utils_pong = await call(key, "utils__ping")
    check("same tool name on two servers goes to the right one",
          "woocommerce" in woo_pong and "shop-utils" in utils_pong)

    # Permissions are enforced on calls too, not only on the list.
    ok, text = await call(key, "woo__create_product", {"name": "e2e", "price": 1})
    check("member calling a hidden write tool is refused", not ok and "may not use" in text)

    # SSRF guard.
    for url in ("http://169.254.169.254/latest/meta-data", "http://gateway-postgres.gateway:5432/"):
        response = admin.post("/api/servers", json={"name": "ssrf_check", "url": url})
        check(f"internal URL refused: {url}", response.status_code == 422)

    # Disable a server: its tools disappear and calls are refused.
    utils = server_named(admin, "utils")
    admin.patch(f"/api/servers/{utils['id']}", json={"enabled": False})
    names = await tool_names(key)
    ok, text = await call(key, "utils__ping")
    check("disabled server's tools disappear", not any(n.startswith("utils__") for n in names))
    check("disabled server's tools are refused", not ok and "disabled" in text)
    admin.patch(f"/api/servers/{utils['id']}", json={"enabled": True})

    if slow:
        started = time.monotonic()
        ok, text = await call(key, "utils__slow_task", {"seconds": 40})
        check("slow upstream times out with a clear error",
              not ok and "no answer within" in text, f"{time.monotonic() - started:.1f}s")
        ok, _ = await call(key, "woo__ping")
        check("other servers keep working after a timeout", ok)

        async def burst(client):
            results = []
            for _ in range(65):
                results.append((await client.call_tool("utils__ping", {})).content[0].text)
            return results
        results = await mcp(key, burst)
        check("rate limit refuses calls over the limit", any(r.startswith("Rate limit") for r in results))

    # Revoke the key: the next request is rejected.
    key_id = member.get("/api/keys").json()[0]["id"]
    admin.post(f"/api/keys/{key_id}/revoke")
    try:
        await tool_names(key)
        check("revoked key is rejected", False)
    except BaseException:  # the MCP client raises on the 401
        check("revoked key is rejected", True)

    # Audit log: the member's calls, including refusals, are there under their name.
    rows = admin.get("/api/audit", params={"user_email": MEMBER["email"], "limit": 200}).json()
    outcomes = {row["outcome"] for row in rows}
    check("audit log has the member's calls", any(r["tool_name"] == "list_orders" for r in rows))
    check("audit log records refusals", "denied" in outcomes, ", ".join(sorted(outcomes)))


if __name__ == "__main__":
    asyncio.run(main(slow="--slow" in sys.argv))
    print(f"\n{'All checks passed.' if not failures else f'{len(failures)} check(s) failed.'}")
    sys.exit(1 if failures else 0)
