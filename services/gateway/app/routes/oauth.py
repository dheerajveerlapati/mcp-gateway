"""OAuth login for MCP clients, following the MCP authorization spec
(OAuth 2.1: discovery, dynamic client registration, authorization code + PKCE).

Instead of pasting an API key, a client like Claude Code can log the user in
through the browser:

1. It calls /mcp without a token and gets 401 with
   WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"
2. It reads that document and /.well-known/oauth-authorization-server to find
   the endpoints below, and registers itself at /oauth/register.
3. It opens the browser at /oauth/authorize. We check the request and send the
   browser on to the dashboard's consent page (/authorize-app), where the user
   logs in (if needed) and clicks Allow or Deny.
4. On Allow, the browser goes back to the app's redirect_uri with a one-time
   code. The app exchanges it at /oauth/token, proving with its PKCE
   code_verifier that it is the same app that started the flow.
5. It calls /mcp with the access token: same permissions and audit as an API key.

Rules: PKCE S256 is required; redirect URIs must be registered, match exactly,
and be https or a loopback address; codes are single-use and live 5 minutes;
tokens are random, stored only as SHA-256, and can be revoked in the dashboard.
"""

import base64
import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlencode, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import current_user, get_db
from app.config import settings
from app.db import OAuthClient, OAuthCode, OAuthToken, User
from app.security import hash_token

router = APIRouter(tags=["oauth"])

ACCESS_TOKEN_PREFIX = "mgo_"  # tells /mcp this is an OAuth token, not an API key
ACCESS_LIFETIME = timedelta(hours=1)
REFRESH_LIFETIME = timedelta(days=30)
CODE_LIFETIME = timedelta(minutes=5)


LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


def issuer(host: str | None = None) -> str:
    """The gateway's URL as this client reached it, for the OAuth documents.

    MCP clients send tokens only over https, or over plain http to a loopback
    address. Locally the gateway is plain http, so a client on this machine
    uses http://localhost/mcp, and the documents must then name localhost too.
    Only loopback hosts are taken from the request; any other Host header gets
    the configured public URL, so a request cannot make us advertise its host.
    """
    if host and urlsplit(f"//{host}").hostname in LOOPBACK_HOSTS:
        return f"http://{host}"
    return settings.public_url


# ---------- Discovery ----------

@router.get("/.well-known/oauth-protected-resource")
@router.get("/.well-known/oauth-protected-resource/mcp")
async def protected_resource_metadata(request: Request):
    """RFC 9728: what is protected, and who issues tokens for it."""
    base = issuer(request.headers.get("host"))
    return {"resource": f"{base}/mcp", "authorization_servers": [base],
            "bearer_methods_supported": ["header"]}


@router.get("/.well-known/oauth-authorization-server")
async def authorization_server_metadata(request: Request):
    """RFC 8414: where the login endpoints are and what they support."""
    base = issuer(request.headers.get("host"))
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],  # public clients, protected by PKCE
    }


# ---------- Dynamic client registration (RFC 7591) ----------

class Registration(BaseModel):
    redirect_uris: list[str] = Field(min_length=1, max_length=5)
    client_name: str = Field(default="MCP client", max_length=200)


def allowed_redirect(uri: str) -> bool:
    """https anywhere, or http only back to this machine (CLI apps listen on localhost)."""
    parts = urlsplit(uri)
    return parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1"))


@router.post("/oauth/register", status_code=201)
async def register(body: Registration, db: AsyncSession = Depends(get_db)):
    bad = [uri for uri in body.redirect_uris if not allowed_redirect(uri)]
    if bad:
        return oauth_error("invalid_redirect_uri", f"Redirect URIs must be https or loopback: {bad}")
    client = OAuthClient(client_id=secrets.token_urlsafe(16), name=body.client_name,
                         redirect_uris=json.dumps(body.redirect_uris))
    db.add(client)
    await db.commit()
    # Registering grants nothing by itself: a user still has to approve the app.
    return {"client_id": client.client_id, "client_name": client.name, "redirect_uris": body.redirect_uris,
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"], "client_id_issued_at": int(datetime.now(UTC).timestamp())}


# ---------- Authorization (browser) ----------

@router.get("/oauth/authorize")
async def authorize(request: Request, db: AsyncSession = Depends(get_db)):
    query = request.query_params
    client = await db.get(OAuthClient, query.get("client_id", ""))
    redirect_uri = query.get("redirect_uri", "")
    if client is None or redirect_uri not in json.loads(client.redirect_uris):
        # Never redirect to an address we cannot vouch for: show the error here.
        return HTMLResponse("<h1>Unknown app or redirect address</h1>", status_code=400)
    if query.get("response_type") != "code" or query.get("code_challenge_method") != "S256" \
            or not query.get("code_challenge"):
        return RedirectResponse(with_params(redirect_uri, error="invalid_request",
                                            error_description="PKCE with S256 is required",
                                            state=query.get("state")), status_code=302)
    # The dashboard shows who is asking and lets the logged-in user decide. It is
    # always the public URL: that is where the person's login cookie lives.
    return RedirectResponse(f"{settings.public_url}/authorize-app?{request.url.query}", status_code=302)


class Consent(BaseModel):
    client_id: str
    redirect_uri: str
    code_challenge: str = Field(min_length=43, max_length=128)
    state: str | None = None
    approve: bool


@router.get("/api/oauth/clients/{client_id}")
async def client_info(client_id: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """The consent page asks for the app's name to show the user."""
    client = await db.get(OAuthClient, client_id)
    if client is None:
        raise HTTPException(404, "Unknown app.")
    return {"client_id": client.client_id, "name": client.name}


@router.post("/api/oauth/consent")
async def consent(body: Consent, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """The user clicked Allow or Deny. Returns where to send the browser next."""
    client = await db.get(OAuthClient, body.client_id)
    if client is None or body.redirect_uri not in json.loads(client.redirect_uris):
        raise HTTPException(400, "Unknown app or redirect address.")
    if not body.approve:
        return {"redirect_to": with_params(body.redirect_uri, error="access_denied", state=body.state)}

    code = secrets.token_urlsafe(32)
    db.add(OAuthCode(code_hash=hash_token(code), client_id=client.client_id, user_id=user.id,
                     redirect_uri=body.redirect_uri, code_challenge=body.code_challenge,
                     expires_at=datetime.now(UTC) + CODE_LIFETIME))
    await db.commit()
    return {"redirect_to": with_params(body.redirect_uri, code=code, state=body.state)}


# ---------- Token endpoint ----------

@router.post("/oauth/token")
async def token(request: Request, db: AsyncSession = Depends(get_db)):
    # OAuth sends form fields (application/x-www-form-urlencoded).
    form = {key: values[0] for key, values in parse_qs((await request.body()).decode()).items()}
    now = datetime.now(UTC)

    if form.get("grant_type") == "authorization_code":
        code = await db.get(OAuthCode, hash_token(form.get("code", "")))
        if code is None or code.used or code.expires_at < now:
            return oauth_error("invalid_grant", "The code is invalid, used or expired.")
        if code.client_id != form.get("client_id") or code.redirect_uri != form.get("redirect_uri"):
            return oauth_error("invalid_grant", "The code was issued to another app or address.")
        if not pkce_matches(form.get("code_verifier", ""), code.code_challenge):
            return oauth_error("invalid_grant", "PKCE verification failed.")
        code.used = True  # single use, even if what follows fails
        return await issue_tokens(db, code.client_id, code.user_id)

    if form.get("grant_type") == "refresh_token":
        refresh = await db.scalar(select(OAuthToken).where(
            OAuthToken.token_hash == hash_token(form.get("refresh_token", "")), OAuthToken.kind == "refresh"))
        if refresh is None or refresh.revoked_at or refresh.expires_at < now \
                or refresh.client_id != form.get("client_id"):
            return oauth_error("invalid_grant", "The refresh token is invalid, revoked or expired.")
        refresh.revoked_at = now  # rotation: each refresh token works once
        return await issue_tokens(db, refresh.client_id, refresh.user_id)

    return oauth_error("unsupported_grant_type", "Use authorization_code or refresh_token.")


async def issue_tokens(db: AsyncSession, client_id: str, user_id: int) -> JSONResponse:
    access = ACCESS_TOKEN_PREFIX + secrets.token_urlsafe(32)
    refresh = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    db.add(OAuthToken(token_hash=hash_token(access), kind="access", client_id=client_id, user_id=user_id,
                      expires_at=now + ACCESS_LIFETIME))
    db.add(OAuthToken(token_hash=hash_token(refresh), kind="refresh", client_id=client_id, user_id=user_id,
                      expires_at=now + REFRESH_LIFETIME))
    await db.commit()
    return JSONResponse({"access_token": access, "token_type": "Bearer",
                         "expires_in": int(ACCESS_LIFETIME.total_seconds()), "refresh_token": refresh},
                        headers={"Cache-Control": "no-store"})


async def user_from_access_token(db: AsyncSession, token: str) -> User | None:
    """Used by /mcp for tokens that start with mgo_."""
    row = await db.scalar(select(OAuthToken).where(
        OAuthToken.token_hash == hash_token(token), OAuthToken.kind == "access"))
    if row is None or row.revoked_at or row.expires_at < datetime.now(UTC):
        return None
    return await db.get(User, row.user_id)


# ---------- Connected apps (dashboard) ----------

@router.get("/api/oauth/apps")
async def connected_apps(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Apps holding a live token for this user."""
    rows = await db.execute(
        select(OAuthClient.client_id, OAuthClient.name, OAuthToken.created_at)
        .join(OAuthToken, OAuthToken.client_id == OAuthClient.client_id)
        .where(OAuthToken.user_id == user.id, OAuthToken.revoked_at.is_(None),
               OAuthToken.expires_at > datetime.now(UTC))
        .order_by(OAuthToken.created_at.desc())
    )
    apps = {}
    for client_id, name, created_at in rows:
        apps.setdefault(client_id, {"client_id": client_id, "name": name, "last_login": created_at})
    return list(apps.values())


@router.delete("/api/oauth/apps/{client_id}", status_code=204)
async def disconnect_app(client_id: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Revoke every token this app holds for this user: its next request is refused."""
    tokens = await db.scalars(select(OAuthToken).where(
        OAuthToken.user_id == user.id, OAuthToken.client_id == client_id, OAuthToken.revoked_at.is_(None)))
    for row in tokens:
        row.revoked_at = datetime.now(UTC)
    await db.commit()


# ---------- Helpers ----------

def pkce_matches(verifier: str, challenge: str) -> bool:
    """S256: the challenge is base64url(sha256(verifier)) without padding."""
    digest = hashlib.sha256(verifier.encode()).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return bool(verifier) and secrets.compare_digest(expected, challenge)


def with_params(uri: str, **params) -> str:
    query = urlencode({k: v for k, v in params.items() if v is not None})
    return f"{uri}{'&' if '?' in uri else '?'}{query}"


def oauth_error(error: str, description: str) -> JSONResponse:
    return JSONResponse({"error": error, "error_description": description}, status_code=400)
