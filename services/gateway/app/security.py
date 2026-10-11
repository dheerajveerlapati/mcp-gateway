"""Small security helpers. Each function does one thing.

Passwords    argon2: deliberately slow, because people choose guessable passwords.
API keys     256 random bits + SHA-256: a fast hash is fine, nobody can guess
             a random 256-bit key, and every MCP request needs a quick lookup.
Credentials  Fernet (AES + HMAC) encryption for upstream server secrets.
Tokens       signed JWTs: the dashboard login cookie, and the short-lived
             token the chat agent uses to call /mcp as the logged-in user.
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet

from app.config import settings

API_KEY_PREFIX = "mgw_"

_passwords = PasswordHasher()
_fernet = Fernet(settings.encryption_key)


# ---------- Passwords ----------

def hash_password(password: str) -> str:
    return _passwords.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _passwords.verify(password_hash, password)
    except VerifyMismatchError:
        return False


# Used when the email is unknown, so a failed login takes the same time
# either way and does not reveal which emails exist.
DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(16))


# ---------- API keys and one-time tokens ----------

def new_api_key() -> str:
    return API_KEY_PREFIX + secrets.token_urlsafe(32)


def new_invite_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """SHA-256 of an API key or invite token. This is what the database stores."""
    return hashlib.sha256(token.encode()).hexdigest()


# ---------- Upstream credentials ----------

def encrypt(plain_text: str) -> str:
    return _fernet.encrypt(plain_text.encode()).decode()


def decrypt(cipher_text: str) -> str:
    return _fernet.decrypt(cipher_text.encode()).decode()


# ---------- Signed tokens (JWT) ----------
# "audience" says what a token is for, so a login cookie can never be used
# as an MCP token or the other way round.

SESSION_AUDIENCE = "dashboard"
CHAT_AUDIENCE = "mcp-chat"


def create_token(user_id: int, audience: str, lifetime: timedelta) -> str:
    now = datetime.now(UTC)
    claims = {"sub": str(user_id), "aud": audience, "iat": now, "exp": now + lifetime}
    return jwt.encode(claims, settings.session_secret, algorithm="HS256")


def read_token(token: str, audience: str) -> int | None:
    """Return the user id if the token is valid, unexpired and for this audience."""
    try:
        claims = jwt.decode(token, settings.session_secret, algorithms=["HS256"], audience=audience)
    except jwt.InvalidTokenError:
        return None
    return int(claims["sub"])
