import { Box, ChevronRight, Link2, Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { api, type Server } from '../api'
import { useMe } from '../session'
import { ErrorText, Page, PageHeader, StatusBadge, formatTime, messageOf } from '../ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Skeleton } from '@/components/ui/misc'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// Registered MCP servers with their live status and tools.
// Everyone can look; only admins can add, edit, disable or remove.
export default function Servers() {
  const me = useMe()
  const isAdmin = me.role === 'admin'
  const [servers, setServers] = useState<Server[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Server | 'new' | 'hosted' | null>(null)

  async function load() {
    try {
      setServers(await api<Server[]>('/api/servers'))
    } catch (e) {
      setError(messageOf(e))
    }
  }

  // Refresh every 5 seconds so status changes (e.g. a pod dying) show up.
  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  async function run(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
      await load()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const setAccess = (s: Server, tool: string, access: string) =>
    run(() => api(`/api/servers/${s.id}/tools/${encodeURIComponent(tool)}/access`, { method: 'PUT', body: { access } }))
  const toggle = (s: Server) => run(() => api(`/api/servers/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }))
  const remove = (s: Server) => {
    if (confirm(`Remove server "${s.name}"? Its tools disappear for everyone.`)) {
      run(() => api(`/api/servers/${s.id}`, { method: 'DELETE' }))
    }
  }
  const done = () => {
    setEditing(null)
    load()
  }

  const connected = servers?.filter(s => s.status === 'connected').length ?? 0
  const toolCount = servers?.reduce((n, s) => n + (s.status === 'connected' ? s.tools.length : 0), 0) ?? 0

  return (
    <Page>
      <PageHeader
        title="MCP servers"
        description="Every enabled server's tools are available to the team through one endpoint. Status refreshes every few seconds."
        actions={
          isAdmin && (
            <>
              <Button variant="outline" onClick={() => setEditing('hosted')}>
                <Box /> Add by image
              </Button>
              <Button onClick={() => setEditing('new')}>
                <Plus /> Add server
              </Button>
            </>
          )
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Servers" value={servers?.length} />
        <Stat label="Connected" value={servers ? `${connected} of ${servers.length}` : undefined} />
        <Stat label="Tools available" value={servers ? toolCount : undefined} />
      </div>

      <div className="space-y-4">
        <ErrorText error={error} />
        {editing === 'hosted' && <HostedServerForm onDone={done} />}
        {editing && editing !== 'hosted' && <ServerForm server={editing === 'new' ? null : editing} onDone={done} />}

        {!servers && [0, 1, 2].map(i => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
        {servers?.map(s => (
          <Card key={s.id} className="gap-0 py-0">
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[15px] font-semibold">{s.name}</span>
                  <StatusBadge status={s.status} />
                  {s.image && <Badge variant="outline">hosted</Badge>}
                </div>
                <div className="mt-1 flex items-center gap-1.5 truncate font-mono text-xs text-muted-foreground">
                  {s.image ? <Box className="size-3 shrink-0" /> : <Link2 className="size-3 shrink-0" />}
                  <span className="truncate">{s.image ?? s.url}</span>
                </div>
              </div>
              {isAdmin && (
                <div className="flex items-center gap-1">
                  <label className="mr-2 flex items-center gap-2 text-xs text-muted-foreground">
                    {s.enabled ? 'Enabled' : 'Disabled'}
                    <Switch checked={s.enabled} onCheckedChange={() => toggle(s)} />
                  </label>
                  {!s.image && (
                    <Button variant="ghost" size="icon-sm" onClick={() => setEditing(s)} title="Edit">
                      <Pencil />
                    </Button>
                  )}
                  <Button variant="ghost-destructive" size="icon-sm" onClick={() => remove(s)} title="Remove">
                    <Trash2 />
                  </Button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t px-5 py-2.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Lock className="size-3" />
                {s.auth_type === 'none' ? 'No auth' : s.auth_type === 'bearer' ? 'Bearer token' : `Header ${s.auth_header}`}
                {s.has_credential && ' · credential encrypted, never shown'}
              </span>
              <span>Checked {formatTime(s.checked_at)}</span>
            </div>

            {s.error && (
              <div className="border-t bg-destructive/5 px-5 py-2.5 text-xs text-destructive">Unreachable: {s.error}</div>
            )}

            {s.tools.length > 0 && (
              <Collapsible className="group/tools border-t">
                <CollapsibleTrigger className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-sm font-medium outline-none hover:bg-muted/40">
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]/tools:rotate-90" />
                  {s.tools.length} tools
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    {s.tools.filter(t => t.access === 'everyone').length} for everyone ·{' '}
                    {s.tools.filter(t => t.access === 'admins').length} admin-only
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-5">Tool</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="w-56 pr-5">Who may use it</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.tools.map(t => (
                        <TableRow key={t.name}>
                          <TableCell className="pl-5 font-mono text-xs whitespace-nowrap">
                            <span className="text-muted-foreground">{s.name}__</span>
                            {t.name}
                          </TableCell>
                          <TableCell className="max-w-md text-xs text-muted-foreground">
                            <span className="line-clamp-2">{t.description}</span>
                          </TableCell>
                          <TableCell className="pr-5">
                            {isAdmin ? (
                              <NativeSelect
                                className="w-48"
                                value={t.overridden ? t.access : 'default'}
                                onChange={e => setAccess(s, t.name, e.target.value)}
                              >
                                <option value="default">Default ({t.read_only ? 'everyone' : 'admins'})</option>
                                <option value="everyone">Everyone</option>
                                <option value="admins">Admins only</option>
                              </NativeSelect>
                            ) : (
                              <Badge variant={t.access === 'everyone' ? 'success' : 'secondary'}>
                                {t.access === 'everyone' ? 'Everyone' : 'Admins only'}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="border-t px-5 py-2.5 text-xs text-muted-foreground">
                    Read-only tools are for everyone; tools that change things are admin-only unless an admin allows them.
                  </p>
                </CollapsibleContent>
              </Collapsible>
            )}
            {s.skipped_tools.length > 0 && (
              <div className="border-t px-5 py-2.5 text-xs text-muted-foreground">
                Hidden (name invalid once prefixed): {s.skipped_tools.join(', ')}
              </div>
            )}
          </Card>
        ))}
      </div>
    </Page>
  )
}

function Stat({ label, value }: { label: string; value: ReactNode | undefined }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-xs">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value ?? <Skeleton className="h-7 w-12" />}</div>
    </div>
  )
}

function FormCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card className="border-primary/20">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

// Add a new server, or edit an existing one. For an existing server the
// credential field is empty: leave it empty to keep the stored one.
function ServerForm({ server, onDone }: { server: Server | null; onDone: () => void }) {
  const [name, setName] = useState(server?.name ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [authType, setAuthType] = useState(server?.auth_type ?? 'none')
  const [authHeader, setAuthHeader] = useState(server?.auth_header ?? '')
  const [credential, setCredential] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const body = {
      url,
      auth_type: authType,
      auth_header: authType === 'header' ? authHeader : null,
      ...(credential ? { credential } : {}),
    }
    setSaving(true)
    try {
      if (server) await api(`/api/servers/${server.id}`, { method: 'PATCH', body })
      else await api('/api/servers', { method: 'POST', body: { ...body, name } })
      onDone()
    } catch (e) {
      setError(messageOf(e))
      setSaving(false)
    }
  }

  return (
    <FormCard
      title={server ? `Edit ${server.name}` : 'Add an MCP server'}
      description="Any server that speaks MCP over Streamable HTTP. The credential is encrypted and never shown again."
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        {!server && (
          <Label>
            Name
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="github" required />
            <span className="text-xs font-normal text-muted-foreground">Also the tool prefix: github__create_issue</span>
          </Label>
        )}
        <Label className={server ? 'sm:col-span-2' : undefined}>
          Streamable HTTP URL
          <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/mcp" required />
        </Label>
        <Label>
          Authentication
          <NativeSelect value={authType} onChange={e => setAuthType(e.target.value as Server['auth_type'])}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
          </NativeSelect>
        </Label>
        {authType === 'header' && (
          <Label>
            Header name
            <Input value={authHeader} onChange={e => setAuthHeader(e.target.value)} placeholder="X-API-Key" required />
          </Label>
        )}
        {authType !== 'none' && (
          <Label>
            {server?.has_credential ? 'New credential' : 'Credential'}
            <Input
              type="password"
              value={credential}
              onChange={e => setCredential(e.target.value)}
              autoComplete="off"
              placeholder={server?.has_credential ? 'Leave empty to keep the current one' : ''}
            />
          </Label>
        )}
        <div className="sm:col-span-2">
          <ErrorText error={error} />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />} Save
          </Button>
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </FormCard>
  )
}

// Run an MCP server image in the cluster. The gateway creates its Deployment,
// Service, Secret and NetworkPolicy, and registers it.
function HostedServerForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [port, setPort] = useState('8000')
  const [path, setPath] = useState('/mcp')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    // One KEY=value per line.
    const env: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const [key, ...rest] = line.split('=')
      if (key.trim()) env[key.trim()] = rest.join('=').trim()
    }
    setSaving(true)
    try {
      await api('/api/servers/hosted', { method: 'POST', body: { name, image, port: Number(port), path, env } })
      onDone()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormCard
      title="Add an MCP server by container image"
      description={
        <>
          Runs in the <code className="font-mono">mcp-hosted</code> namespace as a non-root container with limits. Only the
          gateway can reach it. It must serve MCP over Streamable HTTP on the port and path below.
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        <Label>
          Name
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="weather" required />
        </Label>
        <Label>
          Image
          <Input value={image} onChange={e => setImage(e.target.value)} placeholder="ghcr.io/owner/weather-mcp:1.0" required />
        </Label>
        <Label>
          Port
          <Input value={port} onChange={e => setPort(e.target.value)} required />
        </Label>
        <Label>
          Path
          <Input value={path} onChange={e => setPath(e.target.value)} required />
        </Label>
        <Label className="sm:col-span-2">
          Environment variables
          <Textarea rows={3} className="font-mono" value={envText} onChange={e => setEnvText(e.target.value)} placeholder="API_KEY=..." />
          <span className="text-xs font-normal text-muted-foreground">One KEY=value per line, stored in the server's own Secret.</span>
        </Label>
        <div className="sm:col-span-2">
          <ErrorText error={error} />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />} {saving ? 'Deploying…' : 'Deploy'}
          </Button>
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </FormCard>
  )
}
