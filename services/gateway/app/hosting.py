"""Hosted MCP servers: an admin gives a container image instead of a URL, and
the gateway runs it in the cluster.

For a server named "weather" it creates, in the hosted namespace (mcp-hosted):
  Secret         mcp-weather       the admin's environment variables + MCP_TOKEN
  Deployment     mcp-weather       the image: non-root, read-only filesystem,
                                   CPU/memory limits, no Kubernetes API token
  Service        mcp-weather       its in-cluster address
  NetworkPolicy  mcp-weather       in: only the gateway; out: DNS + public internet

and registers http://mcp-weather.mcp-hosted:<port><path> as a server whose
bearer credential is the random MCP_TOKEN (images that ignore it still work).
Removing the server deletes all four objects.

The gateway talks to the Kubernetes API with plain HTTPS calls and its own
ServiceAccount token. Its Role (charts/gateway/templates/hosted.yaml) allows
exactly these four kinds of objects in exactly this one namespace.

Objects are written with server-side apply (PATCH, application/apply-patch),
which creates or updates in one idempotent call: retrying is always safe.
"""

import json
import os
import secrets

import httpx2

from app.config import settings

SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"

# path in the API -> (API group prefix, resource name)
RESOURCES = {
    "Secret": ("/api/v1", "secrets"),
    "Service": ("/api/v1", "services"),
    "Deployment": ("/apis/apps/v1", "deployments"),
    "NetworkPolicy": ("/apis/networking.k8s.io/v1", "networkpolicies"),
}


class HostingError(Exception):
    """The Kubernetes API refused or failed a request."""


def object_name(server_name: str) -> str:
    # Kubernetes names allow "-" but not "_".
    return "mcp-" + server_name.replace("_", "-")


def server_url(server_name: str, port: int, path: str) -> str:
    return f"http://{object_name(server_name)}.{settings.hosted_namespace}:{port}{path}"


def kubernetes_api() -> httpx2.AsyncClient:
    """An HTTPS client for the Kubernetes API, using this pod's ServiceAccount."""
    with open(f"{SA_DIR}/token") as f:
        token = f.read().strip()
    host, port = os.environ["KUBERNETES_SERVICE_HOST"], os.environ["KUBERNETES_SERVICE_PORT"]
    return httpx2.AsyncClient(base_url=f"https://{host}:{port}", verify=f"{SA_DIR}/ca.crt",
                              headers={"Authorization": f"Bearer {token}"}, timeout=20)


async def deploy(server_name: str, image: str, port: int, env: dict[str, str]) -> str:
    """Create or update the server's objects. Returns the bearer token to call it with."""
    name = object_name(server_name)
    token = secrets.token_urlsafe(24)
    labels = {"app.kubernetes.io/name": name, "app.kubernetes.io/component": "hosted-mcp-server",
              "app.kubernetes.io/managed-by": "mcp-gateway"}

    async with kubernetes_api() as api:
        await apply(api, {
            "apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "labels": labels},
            "stringData": {**env, "MCP_TOKEN": token},
        })
        await apply(api, deployment(name, image, port, labels))
        await apply(api, {
            "apiVersion": "v1", "kind": "Service", "metadata": {"name": name, "labels": labels},
            "spec": {"selector": {"app.kubernetes.io/name": name},
                     "ports": [{"name": "http", "port": port, "targetPort": port}]},
        })
        await apply(api, network_policy(name, port, labels))
    return token


async def remove(server_name: str) -> None:
    """Delete the server's objects. Objects that are already gone are fine."""
    name = object_name(server_name)
    async with kubernetes_api() as api:
        for kind in ("Deployment", "Service", "NetworkPolicy", "Secret"):
            prefix, resource = RESOURCES[kind]
            response = await api.delete(f"{prefix}/namespaces/{settings.hosted_namespace}/{resource}/{name}")
            if response.status_code not in (200, 202, 404):
                raise HostingError(f"Deleting {kind} {name} failed: HTTP {response.status_code}")


async def apply(api: httpx2.AsyncClient, manifest: dict) -> None:
    """Server-side apply: create the object, or update it to match."""
    prefix, resource = RESOURCES[manifest["kind"]]
    name = manifest["metadata"]["name"]
    manifest["metadata"]["namespace"] = settings.hosted_namespace
    response = await api.patch(
        f"{prefix}/namespaces/{settings.hosted_namespace}/{resource}/{name}",
        params={"fieldManager": "mcp-gateway", "force": "true"},
        content=json.dumps(manifest),
        headers={"Content-Type": "application/apply-patch+yaml"},  # JSON is valid YAML
    )
    if response.status_code >= 400:
        reason = response.json().get("message", response.text[:200]) if response.content else ""
        raise HostingError(f"Creating {manifest['kind']} {name} failed: {reason}")


def deployment(name: str, image: str, port: int, labels: dict) -> dict:
    return {
        "apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": name, "labels": labels},
        "spec": {
            "replicas": 1,
            "selector": {"matchLabels": {"app.kubernetes.io/name": name}},
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "automountServiceAccountToken": False,  # no Kubernetes API access
                    "securityContext": {"runAsNonRoot": True, "runAsUser": 10001,
                                        "seccompProfile": {"type": "RuntimeDefault"}},
                    "containers": [{
                        "name": "server",
                        "image": image,
                        "ports": [{"name": "http", "containerPort": port}],
                        "envFrom": [{"secretRef": {"name": name}}],
                        "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                                            "capabilities": {"drop": ["ALL"]}},
                        # Any image: we can only assume it listens on its port.
                        "readinessProbe": {"tcpSocket": {"port": port}, "periodSeconds": 5},
                        "livenessProbe": {"tcpSocket": {"port": port}, "periodSeconds": 20},
                        "resources": {"requests": {"cpu": "50m", "memory": "64Mi"},
                                      "limits": {"cpu": "500m", "memory": "256Mi"}},
                        "volumeMounts": [{"name": "tmp", "mountPath": "/tmp"}],
                    }],
                    "volumes": [{"name": "tmp", "emptyDir": {}}],
                },
            },
        },
    }


def network_policy(name: str, port: int, labels: dict) -> dict:
    private = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]
    return {
        "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": {"name": name, "labels": labels},
        "spec": {
            "podSelector": {"matchLabels": {"app.kubernetes.io/name": name}},
            "policyTypes": ["Ingress", "Egress"],
            "ingress": [{
                "from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": settings.gateway_namespace}},
                          "podSelector": {"matchLabels": {"app.kubernetes.io/name": "gateway"}}}],
                "ports": [{"port": port}],
            }],
            "egress": [
                {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
                         "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}],
                 "ports": [{"port": 53, "protocol": "UDP"}, {"port": 53, "protocol": "TCP"}]},
                {"to": [{"ipBlock": {"cidr": "0.0.0.0/0", "except": private}}], "ports": [{"port": 443}]},
            ],
        },
    }

