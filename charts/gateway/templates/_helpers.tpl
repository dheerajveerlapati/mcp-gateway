{{/* Labels shared by every resource in this chart. */}}
{{- define "gateway.labels" -}}
app.kubernetes.io/part-of: mcp-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* Full image reference [registry/]repository:tag.
     Usage: include "gateway.imageRef" (list .Values.gateway.image .Chart.AppVersion) */}}
{{- define "gateway.imageRef" -}}
{{- $image := index . 0 -}}
{{- $tag := $image.tag | default (index . 1) -}}
{{- if $image.registry -}}
{{ $image.registry }}/{{ $image.repository }}:{{ $tag }}
{{- else -}}
{{ $image.repository }}:{{ $tag }}
{{- end -}}
{{- end }}

{{/* Environment of the gateway (and its migration init container). */}}
{{- define "gateway.env" -}}
{{- $secret := .Values.existingSecret -}}
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: db-password }
- name: DATABASE_URL # $(DB_PASSWORD) is filled in by Kubernetes from the line above
  value: postgresql+asyncpg://gateway:$(DB_PASSWORD)@{{ .Release.Name }}-postgres:5432/gateway
- name: SESSION_SECRET
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: session-secret }
- name: ENCRYPTION_KEY
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: encryption-key }
- name: BOOTSTRAP_ADMIN_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: admin-password }
- name: WOO_MCP_TOKEN
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: woo-mcp-token }
- name: UTILS_MCP_TOKEN
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: utils-mcp-token, optional: true }
- { name: UTILS_MCP_URL, value: {{ .Values.gateway.utilsMcpUrl | quote }} }
- { name: BOOTSTRAP_ADMIN_EMAIL, value: {{ .Values.gateway.bootstrapAdminEmail | quote }} }
- { name: WOO_MCP_URL, value: {{ .Values.gateway.wooMcpUrl | quote }} }
- { name: PUBLIC_URL, value: {{ include "gateway.publicUrl" . | quote }} }
- { name: UPSTREAM_TIMEOUT_SECONDS, value: {{ .Values.gateway.upstreamTimeoutSeconds | quote }} }
- { name: HEALTH_INTERVAL_SECONDS, value: {{ .Values.gateway.healthIntervalSeconds | quote }} }
- { name: TIMEZONE, value: {{ .Values.gateway.timezone | quote }} }
- { name: ALLOWED_INTERNAL_HOSTS, value: {{ join "," .Values.gateway.allowedInternalHosts | quote }} }
- { name: RATE_LIMIT_PER_MINUTE, value: {{ .Values.gateway.rateLimitPerMinute | quote }} }
- { name: HOSTED_ENABLED, value: {{ .Values.hosted.enabled | quote }} }
- { name: HOSTED_NAMESPACE, value: {{ .Values.hosted.namespace | quote }} }
- { name: GATEWAY_NAMESPACE, value: {{ .Release.Namespace | quote }} }
- { name: LLM_PROVIDER, value: {{ .Values.llm.provider | quote }} }
- { name: LLM_MODEL, value: {{ .Values.llm.model | quote }} }
- name: LLM_API_KEY
  valueFrom:
    secretKeyRef: { name: {{ .Values.llm.existingSecret }}, key: api-key, optional: true }
{{- end }}

{{- define "gateway.publicUrl" -}}
{{ if .Values.ingress.tls.enabled }}https{{ else }}http{{ end }}://{{ .Values.host }}
{{- end }}
