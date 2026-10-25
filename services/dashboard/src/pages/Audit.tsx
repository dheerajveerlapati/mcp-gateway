import { useEffect, useState } from 'react'
import { api, type AuditRow, type ServerStats } from '../api'
import { useMe } from '../session'
import { ErrorText, StatusBadge, formatTime, messageOf } from '../ui'

// Every tool call: who, which server and tool, when, how long, and the outcome.
// Admins see everyone; members see their own calls.
export default function Audit() {
  const me = useMe()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [server, setServer] = useState('')
  const [outcome, setOutcome] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams()
    if (server) params.set('server', server)
    if (outcome) params.set('outcome', outcome)
    if (userEmail) params.set('user_email', userEmail)

    async function load() {
      try {
        setRows(await api<AuditRow[]>(`/api/audit?${params}`))
        setError(null)
      } catch (e) {
        setError(messageOf(e))
      }
    }
    load()
    const timer = setInterval(load, 5000) // live view while demoing
    return () => clearInterval(timer)
  }, [server, outcome, userEmail])

  return (
    <>
      <h1>Audit log</h1>
      {me.role === 'admin' && <ServerStatsTable />}
      <div className="row filters">
        <input value={server} onChange={e => setServer(e.target.value)} placeholder="server, e.g. woo" />
        <select value={outcome} onChange={e => setOutcome(e.target.value)}>
          <option value="">any outcome</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="timeout">timeout</option>
          <option value="denied">denied</option>
        </select>
        {me.role === 'admin' && (
          <input value={userEmail} onChange={e => setUserEmail(e.target.value)} placeholder="user email" />
        )}
      </div>
      <ErrorText error={error} />
      <section className="card">
        <table>
          <thead>
            <tr><th>When</th><th>Who</th><th>Via</th><th>Server</th><th>Tool</th><th>Duration</th><th>Outcome</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{formatTime(r.created_at)}</td>
                <td>{r.user_email}</td>
                <td>{r.source === 'chat' ? 'chat' : 'API key'}</td>
                <td>{r.server_name}</td>
                <td><code>{r.tool_name}</code></td>
                <td>{r.duration_ms} ms</td>
                <td><StatusBadge status={r.outcome} /></td>
                <td className="muted">{r.error}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted">No tool calls yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  )
}

// Calls, error rate and latency per server over the last 24 hours (admins).
function ServerStatsTable() {
  const [stats, setStats] = useState<ServerStats[]>([])

  useEffect(() => {
    const load = () => api<ServerStats[]>('/api/audit/stats').then(setStats).catch(() => setStats([]))
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [])

  return (
    <section className="card">
      <h2>Last 24 hours by server</h2>
      <table>
        <thead>
          <tr><th>Server</th><th>Calls</th><th>Not ok</th><th>Error rate</th><th>Avg</th><th>p95</th></tr>
        </thead>
        <tbody>
          {stats.map(s => (
            <tr key={s.server_name}>
              <td>{s.server_name}</td>
              <td>{s.calls}</td>
              <td>{s.errors}</td>
              <td>{Math.round(s.error_rate * 100)}%</td>
              <td>{s.avg_ms} ms</td>
              <td>{s.p95_ms} ms</td>
            </tr>
          ))}
          {stats.length === 0 && <tr><td colSpan={6} className="muted">No calls yet.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}
