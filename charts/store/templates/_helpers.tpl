{{/* Labels shared by every resource in this chart. */}}
{{- define "store.labels" -}}
app.kubernetes.io/part-of: mcp-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* Full public URL of the shop, e.g. http://store.localtest.me */}}
{{- define "store.siteUrl" -}}
{{ if .Values.ingress.tls.enabled }}https{{ else }}http{{ end }}://{{ .Values.host }}
{{- end }}

{{/* Database settings needed by both WordPress and the WP-CLI setup Job. */}}
{{- define "store.dbEnv" -}}
- name: WORDPRESS_DB_HOST
  value: {{ .Release.Name }}-mariadb:3306
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.existingSecret }}, key: db-password }
{{- end }}
