"""A small async client for the WooCommerce REST API (v3).

How we authenticate
-------------------
Inside the cluster we call WordPress over plain HTTP. On plain HTTP,
WooCommerce refuses API keys sent like a password and requires OAuth 1.0a
"one-legged" signatures instead: every request carries an HMAC signature made
with the consumer secret, so the secret itself never travels over the network.

One WooCommerce detail: it checks the signature against the shop's *public*
home URL (e.g. http://store.localtest.me/wp-json/...), not the internal
address we actually connect to. So we read the home URL from the store once
and sign with that.
"""

import base64
import hashlib
import hmac
import secrets
import time
from urllib.parse import quote, urlsplit

import httpx

API_PREFIX = "/wp-json/wc/v3"


class WooError(Exception):
    """The store returned an error, or could not be reached."""


def _encode(value: object) -> str:
    # OAuth 1.0a percent-encoding (RFC 3986): only A-Z a-z 0-9 - . _ ~ stay as-is.
    return quote(str(value), safe="-._~")


class WooClient:
    def __init__(self, base_url: str, consumer_key: str, consumer_secret: str, timeout: float = 10.0):
        self.consumer_key = consumer_key
        self.consumer_secret = consumer_secret
        self.http = httpx.AsyncClient(base_url=base_url, timeout=timeout)
        self.home_url: str | None = None  # looked up on first use

    async def get(self, path: str, params: dict | None = None) -> dict | list:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, body: dict) -> dict:
        return await self._request("POST", path, body=body)

    async def put(self, path: str, body: dict) -> dict:
        return await self._request("PUT", path, body=body)

    async def _request(self, method: str, path: str, params: dict | None = None, body: dict | None = None):
        # Drop empty filters, so "status=None" simply means "any status".
        params = {key: value for key, value in (params or {}).items() if value is not None}
        url_to_sign = await self._signing_base() + API_PREFIX + path
        params.update(self._oauth_params(method, url_to_sign, params))

        try:
            response = await self.http.request(method, API_PREFIX + path, params=params, json=body)
        except httpx.TimeoutException as error:
            raise WooError("The store did not answer in time.") from error
        except httpx.HTTPError as error:
            raise WooError(f"Could not reach the store ({error.__class__.__name__}).") from error

        if response.status_code >= 400:
            raise WooError(_error_message(response))
        return response.json()

    async def _signing_base(self) -> str:
        """The scheme + host WooCommerce uses when it checks our signature."""
        if self.home_url is None:
            try:
                response = await self.http.get("/wp-json/")
                response.raise_for_status()
            except httpx.HTTPError as error:
                raise WooError(f"Could not reach the store ({error.__class__.__name__}).") from error
            self.home_url = response.json()["home"]

        # Our request arrives over plain HTTP, so WooCommerce rebuilds the URL
        # with "http" even if the public site uses https.
        host = urlsplit(self.home_url).netloc
        return f"http://{host}"

    def _oauth_params(self, method: str, url: str, params: dict) -> dict:
        oauth = {
            "oauth_consumer_key": self.consumer_key,
            "oauth_nonce": secrets.token_hex(16),
            "oauth_signature_method": "HMAC-SHA256",
            "oauth_timestamp": str(int(time.time())),
        }
        # Signature base: METHOD & url & sorted "key=value" pairs, each part encoded.
        all_params = {**params, **oauth}
        pairs = "&".join(f"{_encode(k)}={_encode(v)}" for k, v in sorted(all_params.items()))
        base_string = "&".join([method, _encode(url), _encode(pairs)])

        key = (self.consumer_secret + "&").encode()
        digest = hmac.new(key, base_string.encode(), hashlib.sha256).digest()
        oauth["oauth_signature"] = base64.b64encode(digest).decode()
        return oauth


def _error_message(response: httpx.Response) -> str:
    """Turn a WooCommerce error response into one readable sentence."""
    try:
        message = response.json().get("message", "")
    except ValueError:
        message = ""
    return f"Store returned HTTP {response.status_code}" + (f": {message}" if message else ".")
