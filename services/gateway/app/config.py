"""All gateway settings, read once from environment variables.

In the cluster these come from the Helm chart: plain values from values.yaml,
secrets from the Kubernetes Secret. Nothing secret has a default here.
"""

import os
from dataclasses import dataclass


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable {name}")
    return value


@dataclass(frozen=True)
class Settings:
    database_url: str
    # Signs dashboard login sessions.
    session_secret: str
    # Fernet key that encrypts upstream credentials in the database.
    encryption_key: str
    # Public URL of the dashboard, used in invite links and client config snippets.
    public_url: str

    # The first admin, created on first start when there are no users yet.
    bootstrap_admin_email: str
    bootstrap_admin_password: str

    # The WooCommerce MCP server, registered automatically on first start.
    woo_mcp_url: str
    woo_mcp_token: str

    # How long one upstream tool call may take before we give up.
    upstream_timeout_seconds: float
    # How often every upstream is checked (status + tool list).
    health_interval_seconds: float

    # In-cluster hosts an admin may register (SSRF guard, see url_safety.py),
    # as patterns such as "*.mcp". Every other URL must be a public address.
    allowed_internal_hosts: tuple[str, ...]
    # Tool calls one user may make per minute, across all gateway replicas.
    rate_limit_per_minute: int

    # Chat agent model. Without an API key the chat says it is not configured.
    llm_provider: str  # a LangChain provider name: "groq" or "google_genai"
    llm_model: str
    llm_api_key: str
    # Time zone the agent uses for "today".
    timezone: str


def load_settings() -> Settings:
    return Settings(
        database_url=_required("DATABASE_URL"),
        session_secret=_required("SESSION_SECRET"),
        encryption_key=_required("ENCRYPTION_KEY"),
        public_url=os.environ.get("PUBLIC_URL", "http://dashboard.localtest.me").rstrip("/"),
        bootstrap_admin_email=_required("BOOTSTRAP_ADMIN_EMAIL"),
        bootstrap_admin_password=_required("BOOTSTRAP_ADMIN_PASSWORD"),
        woo_mcp_url=os.environ.get("WOO_MCP_URL", ""),
        woo_mcp_token=os.environ.get("WOO_MCP_TOKEN", ""),
        upstream_timeout_seconds=float(os.environ.get("UPSTREAM_TIMEOUT_SECONDS", "15")),
        health_interval_seconds=float(os.environ.get("HEALTH_INTERVAL_SECONDS", "10")),
        allowed_internal_hosts=tuple(
            p.strip() for p in os.environ.get("ALLOWED_INTERNAL_HOSTS", "*.mcp,*.mcp.svc.cluster.local").split(",")
            if p.strip()
        ),
        rate_limit_per_minute=int(os.environ.get("RATE_LIMIT_PER_MINUTE", "60")),
        llm_provider=os.environ.get("LLM_PROVIDER", "groq"),
        llm_model=os.environ.get("LLM_MODEL", "openai/gpt-oss-120b"),
        llm_api_key=os.environ.get("LLM_API_KEY", ""),
        timezone=os.environ.get("TIMEZONE", "Asia/Kolkata"),
    )


settings = load_settings()
