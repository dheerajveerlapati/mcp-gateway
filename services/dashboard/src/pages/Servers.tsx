import { type FormEvent, useEffect, useState } from 'react'
import { api, type Server } from '../api'
import { useMe } from '../session'
import { ErrorText, StatusBadge, formatTime, messageOf } from '../ui'

// Registered MCP servers with their live status and tools.
// Everyone can look; only admins can add, edit, disable or remove.
export default function Servers() {
  const me = useMe()
  const [servers, setServers] = useState<Server[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Server | 'new' | null>(null)

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

  return (
    <>
      <div className="page-title">
        <h1>MCP servers</h1>
        {me.role === 'admin' && <button onClick={() => setEditing('new')}>Add server</button>}
      </div>
      <ErrorText error={error} />

      {editing && (
        <ServerForm
          server={editing === 'new' ? null : editing}
          onDone={() => { setEditing(null); load() }}
        />
      )}

      {servers.map(s => (
        <section className="card" key={s.id}>
          <div className="row">
            <h2>{s.name}</h2>
            <StatusBadge status={s.status} />
            <span className="muted grow">{s.url}</span>
            {me.role === 'admin' && (
              <>
                <button className="secondary" onClick={() => setEditing(s)}>Edit</button>
                <button className="secondary" onClick={() => toggle(s)}>{s.enabled ? 'Disable' : 'Enable'}</button>
                <button className="danger" onClick={() => remove(s)}>Remove</button>
              </>
            )}
          </div>
          <p className="muted">
            Auth: {s.auth_type === 'none' ? 'none' : s.auth_type === 'bearer' ? 'bearer token' : `header ${s.auth_header}`}
            {s.has_credential && ' · credential stored (encrypted, never shown)'}
            {' · '}checked {formatTime(s.checked_at)}
          </p>
          {s.error && <p className="error">Unreachable: {s.error}</p>}
          {s.tools.length > 0 && (
            <details>
              <summary>{s.tools.length} tools</summary>
              <p className="muted">
                Read-only tools are for everyone; tools that change things are admin-only unless an admin allows them.
              </p>
              <ul className="tools">
                {s.tools.map(t => (
                  <li key={t.name}>
                    <code>{s.name}__{t.name}</code>{' '}
                    {me.role === 'admin' ? (
                      <select
                        value={t.overridden ? t.access : 'default'}
                        onChange={e => setAccess(s, t.name, e.target.value)}
                      >
                        <option value="default">default ({t.read_only ? 'everyone' : 'admins'})</option>
                        <option value="everyone">everyone</option>
                        <option value="admins">admins only</option>
                      </select>
                    ) : (
                      <span className={`badge badge-${t.access === 'everyone' ? 'ok' : 'disabled'}`}>{t.access}</span>
                    )}{' '}
                    <span className="muted">{t.description}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {s.skipped_tools.length > 0 && (
            <p className="muted">Hidden (name too long or invalid once prefixed): {s.skipped_tools.join(', ')}</p>
          )}
        </section>
      ))}
    </>
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

  async function submit(event: FormEvent) {
    event.preventDefault()
    const body = {
      url,
      auth_type: authType,
      auth_header: authType === 'header' ? authHeader : null,
      ...(credential ? { credential } : {}),
    }
    try {
      if (server) await api(`/api/servers/${server.id}`, { method: 'PATCH', body })
      else await api('/api/servers', { method: 'POST', body: { ...body, name } })
      onDone()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{server ? `Edit ${server.name}` : 'Add an MCP server'}</h2>
      {!server && (
        <label>Name (also the tool prefix, e.g. "github" gives github__create_issue)
          <input value={name} onChange={e => setName(e.target.value)} placeholder="github" required />
        </label>
      )}
      <label>Streamable HTTP URL
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/mcp" required />
      </label>
      <label>Authentication
        <select value={authType} onChange={e => setAuthType(e.target.value as Server['auth_type'])}>
          <option value="none">None</option>
          <option value="bearer">Bearer token (Authorization: Bearer …)</option>
          <option value="header">Custom header</option>
        </select>
      </label>
      {authType === 'header' && (
        <label>Header name <input value={authHeader} onChange={e => setAuthHeader(e.target.value)} placeholder="X-API-Key" required /></label>
      )}
      {authType !== 'none' && (
        <label>{server?.has_credential ? 'New credential (leave empty to keep the current one)' : 'Credential'}
          <input type="password" value={credential} onChange={e => setCredential(e.target.value)} autoComplete="off" />
        </label>
      )}
      <ErrorText error={error} />
      <div className="row">
        <button type="submit">Save</button>
        <button type="button" className="secondary" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}
