"""Protection against server-side request forgery (SSRF).

The gateway connects to whatever URL an admin registers. Without a check, a
URL such as http://169.254.169.254/ (cloud metadata) or
http://gateway-postgres.gateway:5432/ would make the gateway probe internal
services on someone's behalf.

The rule: a server URL must resolve only to public internet addresses, unless
its host matches one of the in-cluster MCP host patterns allowed in config
(e.g. "*.mcp" = any Service in the `mcp` namespace).

It is checked when a server is saved and again before every connection,
because what a name resolves to can change after the first check. The
gateway's NetworkPolicy is the second layer: even if this check were bypassed,
the pod cannot open connections to private addresses outside the MCP namespaces.
"""

import asyncio
import ipaddress
import socket
from fnmatch import fnmatch
from urllib.parse import urlsplit

from app.config import settings


class UnsafeUrl(Exception):
    """The URL points somewhere the gateway must not go."""


async def check_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise UnsafeUrl("The URL must look like http(s)://host/path.")
    host = parts.hostname.lower()

    if any(fnmatch(host, pattern) for pattern in settings.allowed_internal_hosts):
        return  # one of our in-cluster MCP servers

    try:
        addresses = await asyncio.get_running_loop().getaddrinfo(host, parts.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise UnsafeUrl(f"Cannot resolve host {host}.") from None

    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        # is_global is False for private, loopback, link-local (cloud metadata),
        # carrier-grade NAT and reserved ranges.
        if not ip.is_global:
            raise UnsafeUrl(
                f"{host} resolves to a non-public address ({ip}). Only public hosts or the "
                f"allowed in-cluster MCP hosts ({', '.join(settings.allowed_internal_hosts)}) can be used."
            )
