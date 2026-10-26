import { AlertTriangle, Plus, Unplug } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { api, type ApiKey } from '../api'
import { CopyBox, EmptyRow, ErrorText, Page, PageHeader, formatTime, messageOf } from '../ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const GATEWAY_URL = `${window.location.origin}/mcp`
// MCP clients use the OAuth browser sign-in over plain http only with a
// loopback address, so a local (http) install signs in at localhost instead.
const SIGN_IN_URL = window.location.protocol === 'https:' ? GATEWAY_URL : 'http://localhost/mcp'

// "My API keys" page: how to connect an MCP client, plus the person's keys.
export default function Keys() {
  return (
    <Page>
      <PageHeader
        title="API keys"
        description="Connect Claude Code, Cursor or MCP Inspector with one URL. Use a key, or just the URL to sign in through the browser."
      />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Connect an MCP client</CardTitle>
            <CardDescription>
              One URL gives you the tools of every server you may use. Clients that support OAuth (e.g. Claude Code) open the
              browser to sign you in when you add just the URL.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <CopyBox label="Gateway URL" value={GATEWAY_URL} />
            <CopyBox label="Claude Code, browser sign-in (no key)" value={`claude mcp add --transport http mcp-gateway ${SIGN_IN_URL}`} />
          </CardContent>
        </Card>
        <KeyList />
        <ConnectedApps />
      </div>
    </Page>
  )
}

type ConnectedApp = { client_id: string; name: string; last_login: string }

// Apps that logged in through OAuth (browser login) and still hold a token.
function ConnectedApps() {
  const [apps, setApps] = useState<ConnectedApp[]>([])
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    api<ConnectedApp[]>('/api/oauth/apps').then(setApps).catch(() => setApps([]))
  }, [reloads])

  async function disconnect(app: ConnectedApp) {
    if (!confirm(`Disconnect ${app.name}? Its next request is refused.`)) return
    await api(`/api/oauth/apps/${encodeURIComponent(app.client_id)}`, { method: 'DELETE' })
    setReloads(n => n + 1)
  }

  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle>Connected apps</CardTitle>
        <CardDescription>Apps you approved through the browser sign-in.</CardDescription>
      </CardHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-6">App</TableHead>
            <TableHead>Last sign-in</TableHead>
            <TableHead className="pr-6" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {apps.map(app => (
            <TableRow key={app.client_id}>
              <TableCell className="pl-6 font-medium">{app.name}</TableCell>
              <TableCell className="text-muted-foreground">{formatTime(app.last_login)}</TableCell>
              <TableCell className="pr-6 text-right">
                <Button variant="ghost-destructive" size="sm" onClick={() => disconnect(app)}>
                  <Unplug /> Disconnect
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {apps.length === 0 && <EmptyRow colSpan={3}>No apps connected.</EmptyRow>}
        </TableBody>
      </Table>
    </Card>
  )
}

// A person's keys: create, list, revoke. Without `userId` it shows your own
// keys; admins pass a userId on the Team page to manage someone else's.
export function KeyList({ userId, title }: { userId?: number; title?: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [name, setName] = useState('')
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0) // bump to fetch the list again
  const reload = () => setReloads(n => n + 1)

  useEffect(() => {
    api<ApiKey[]>(`/api/keys${userId ? `?user_id=${userId}` : ''}`)
      .then(setKeys)
      .catch(e => setError(messageOf(e)))
  }, [userId, reloads])

  async function create(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      const result = await api<{ secret: string }>('/api/keys', { method: 'POST', body: { name, user_id: userId } })
      setNewSecret(result.secret)
      setName('')
      reload()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  async function revoke(key: ApiKey) {
    if (!confirm(`Revoke "${key.name}"? Clients using it stop working immediately.`)) return
    try {
      await api(`/api/keys/${key.id}/revoke`, { method: 'POST' })
      reload()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle>{title ?? 'Your keys'}</CardTitle>
        <CardDescription>Keys are stored only as a hash. Revoking one takes effect on the next request.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-4">
        <form className="flex gap-2" onSubmit={create}>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Key name, e.g. Claude Code on laptop" required />
          <Button type="submit">
            <Plus /> Create key
          </Button>
        </form>
        <ErrorText error={error} />
        {newSecret && (
          <div className="space-y-4 rounded-lg border border-warning/40 bg-warning/5 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="size-4 text-warning" /> Copy this key now. It will not be shown again.
            </p>
            <CopyBox label="API key" value={newSecret} />
            <CopyBox
              label="Claude Code"
              value={`claude mcp add --transport http mcp-gateway ${GATEWAY_URL} --header "Authorization: Bearer ${newSecret}"`}
            />
            <Button variant="outline" size="sm" onClick={() => setNewSecret(null)}>
              Done
            </Button>
          </div>
        )}
      </CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-6">Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="pr-6" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map(k => (
            <TableRow key={k.id} className={k.revoked_at ? 'text-muted-foreground' : undefined}>
              <TableCell className="pl-6 font-medium">{k.name}</TableCell>
              <TableCell className="font-mono text-xs">{k.prefix}…</TableCell>
              <TableCell className="text-xs">{formatTime(k.created_at)}</TableCell>
              <TableCell className="text-xs">{formatTime(k.last_used_at)}</TableCell>
              <TableCell>
                {k.revoked_at ? (
                  <Badge variant="secondary" title={`Revoked ${formatTime(k.revoked_at)}`}>
                    Revoked
                  </Badge>
                ) : (
                  <Badge variant="success">Active</Badge>
                )}
              </TableCell>
              <TableCell className="pr-6 text-right">
                {!k.revoked_at && (
                  <Button variant="ghost-destructive" size="sm" onClick={() => revoke(k)}>
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          {keys.length === 0 && <EmptyRow colSpan={6}>No keys yet.</EmptyRow>}
        </TableBody>
      </Table>
    </Card>
  )
}
