"""Prometheus metrics, served at /metrics (inside the cluster only: the
Ingress does not route /metrics, so it is not public).

mcp_tool_calls_total{server, outcome}    calls by server and ok/error/timeout/denied
mcp_tool_call_seconds{server}            how long calls take (histogram)
mcp_upstream_up{server}                  1 if the last health check connected, else 0

Error rate per server = calls with outcome != "ok" / all calls.
"""

from prometheus_client import Counter, Gauge, Histogram

TOOL_CALLS = Counter("mcp_tool_calls", "Tool calls through the gateway", ["server", "outcome"])
TOOL_CALL_SECONDS = Histogram("mcp_tool_call_seconds", "Duration of tool calls", ["server"],
                              buckets=(0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30))
UPSTREAM_UP = Gauge("mcp_upstream_up", "1 if the upstream answered its last health check", ["server"])
