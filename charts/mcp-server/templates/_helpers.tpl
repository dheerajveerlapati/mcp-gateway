{{/* Labels shared by every resource in this chart. */}}
{{- define "mcp-server.labels" -}}
app.kubernetes.io/part-of: mcp-gateway
app.kubernetes.io/name: {{ .Release.Name }}
app.kubernetes.io/component: mcp-server
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "mcp-server.selectorLabels" -}}
app.kubernetes.io/name: {{ .Release.Name }}
{{- end }}

{{/* Full image reference: [registry/]repository:tag */}}
{{- define "mcp-server.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- if .Values.image.registry -}}
{{ .Values.image.registry }}/{{ .Values.image.repository }}:{{ $tag }}
{{- else -}}
{{ .Values.image.repository }}:{{ $tag }}
{{- end -}}
{{- end }}
