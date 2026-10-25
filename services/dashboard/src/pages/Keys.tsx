import { type FormEvent, useEffect, useState } from 'react'
import { api, type ApiKey } from '../api'
import { CopyBox, ErrorText, formatTime, messageOf } from '../ui'

const GATEWAY_URL = `${window.location.origin}/mcp`

// "My API keys" page: how to connect an MCP client, plus the person's keys.
export default function Keys() {
  return (
    <>
      <h1>API keys</h1>
      <section className="card">
        <h2>Connect an MCP client</h2>
        <p>
          One URL gives you the tools of every enabled server. Either create a key below and add it to your client,
          or add just the URL: clients that support OAuth (e.g. Claude Code) then open the browser to log you in.
        </p>
        <CopyBox label="Gateway URL" value={GATEWAY_URL} />
        <CopyBox label="Claude Code, browser login (no key)" value={`claude mcp add --transport http mcp-gateway ${GATEWAY_URL}`} />
      </section>
      <KeyList />
      <ConnectedApps />
    </>
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
    <section className="card">
      <h2>Connected apps (browser login)</h2>
      <table>
        <thead><tr><th>App</th><th>Last login</th><th /></tr></thead>
        <tbody>
          {apps.map(app => (
            <tr key={app.client_id}>
              <td>{app.name}</td>
              <td>{formatTime(app.last_login)}</td>
              <td><button className="danger" onClick={() => disconnect(app)}>Disconnect</button></td>
            </tr>
          ))}
          {apps.length === 0 && <tr><td colSpan={3} className="muted">No apps connected.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}

// A person's keys: create, list, revoke. Without `userId` it shows your own
// keys; admins pass a userId on the Team page to manage someone else's.
export function KeyList({ userId }: { userId?: number }) {
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
    <section className="card">
      <h2>{userId ? 'Their keys' : 'Your keys'}</h2>
      <form className="row" onSubmit={create}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Key name, e.g. Claude Code on laptop" required />
        <button type="submit">Create key</button>
      </form>
      <ErrorText error={error} />

      {newSecret && (
        <div className="notice">
          <p><strong>Copy this key now. It will not be shown again.</strong></p>
          <CopyBox label="API key" value={newSecret} />
          <CopyBox
            label="Claude Code"
            value={`claude mcp add --transport http mcp-gateway ${GATEWAY_URL} --header "Authorization: Bearer ${newSecret}"`}
          />
          <button className="secondary" onClick={() => setNewSecret(null)}>Done</button>
        </div>
      )}

      <table>
        <thead>
          <tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {keys.map(k => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td><code>{k.prefix}…</code></td>
              <td>{formatTime(k.created_at)}</td>
              <td>{formatTime(k.last_used_at)}</td>
              <td>{k.revoked_at ? `revoked ${formatTime(k.revoked_at)}` : 'active'}</td>
              <td>{!k.revoked_at && <button className="danger" onClick={() => revoke(k)}>Revoke</button>}</td>
            </tr>
          ))}
          {keys.length === 0 && <tr><td colSpan={6} className="muted">No keys yet.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}
