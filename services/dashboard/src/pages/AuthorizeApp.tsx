import { Eye, ScrollText, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api } from '../api'
import { useMe } from '../session'
import { ErrorText, messageOf } from '../ui'
import { AuthLayout } from './Login'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/misc'

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
    <AuthLayout title="Connect an app" description={`Signed in as ${me.email}`}>
      {!appName && !error && <Skeleton className="h-32 w-full" />}
      {appName && (
        <div className="space-y-5">
          <p className="text-sm">
            <span className="font-semibold">{appName}</span> wants to use the MCP gateway as you.
          </p>
          <ul className="space-y-3 text-sm text-muted-foreground">
            <li className="flex gap-3">
              <Eye className="mt-0.5 size-4 shrink-0" /> It sees and calls the same tools you can.
            </li>
            <li className="flex gap-3">
              <ScrollText className="mt-0.5 size-4 shrink-0" /> Every call is in the audit log under your name.
            </li>
            <li className="flex gap-3">
              <Unplug className="mt-0.5 size-4 shrink-0" /> You can disconnect it any time on the API keys page.
            </li>
          </ul>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => decide(false)}>
              Deny
            </Button>
            <Button onClick={() => decide(true)}>Allow</Button>
          </div>
        </div>
      )}
      <ErrorText error={error} />
    </AuthLayout>
  )
}
