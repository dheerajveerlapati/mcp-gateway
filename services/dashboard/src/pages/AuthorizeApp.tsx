import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api } from '../api'
import { useMe } from '../session'
import { ErrorText, messageOf } from '../ui'

// OAuth consent page. An MCP client (e.g. Claude Code) sent the browser here
// via /oauth/authorize. The user is logged in (App shows the login form first
// if not) and decides whether the app may use the gateway as them.
export default function AuthorizeApp() {
  const me = useMe()
  const [params] = useSearchParams()
  const [appName, setAppName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const clientId = params.get('client_id') ?? ''

  useEffect(() => {
    api<{ name: string }>(`/api/oauth/clients/${encodeURIComponent(clientId)}`)
      .then(client => setAppName(client.name))
      .catch(e => setError(messageOf(e)))
  }, [clientId])

  async function decide(approve: boolean) {
    try {
      const { redirect_to } = await api<{ redirect_to: string }>('/api/oauth/consent', {
        method: 'POST',
        body: {
          client_id: clientId,
          redirect_uri: params.get('redirect_uri'),
          code_challenge: params.get('code_challenge'),
          state: params.get('state'),
          approve,
        },
      })
      window.location.href = redirect_to // back to the app, with a one-time code (or "denied")
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <section className="card narrow">
      <h1>Connect an app</h1>
      {appName && (
        <>
          <p><strong>{appName}</strong> wants to use the MCP gateway as <strong>{me.email}</strong>.</p>
          <p className="muted">
            It will see and call the same tools you can, and every call is in the audit log under your name.
            You can disconnect it any time on the API keys page.
          </p>
          <div className="row">
            <button onClick={() => decide(true)}>Allow</button>
            <button className="secondary" onClick={() => decide(false)}>Deny</button>
          </div>
        </>
      )}
      <ErrorText error={error} />
    </section>
  )
}
