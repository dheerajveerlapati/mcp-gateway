import { CheckCircle2 } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { api } from '../api'
import { useMe } from '../session'
import { ErrorText, Page, PageHeader, initials, messageOf } from '../ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/input'

// Your account: who you are, and changing your password.
export default function Account() {
  const me = useMe()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSaved(false)
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { current_password: currentPassword, new_password: newPassword },
      })
      setSaved(true)
      setCurrentPassword('')
      setNewPassword('')
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <Page className="max-w-2xl">
      <PageHeader title="Account" />
      <div className="space-y-6">
        <Card>
          <CardContent className="flex items-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-sm font-medium">
              {initials(me.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{me.name}</div>
              <div className="truncate text-sm text-muted-foreground">{me.email}</div>
            </div>
            <Badge variant="secondary" className="capitalize">
              {me.role}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>Use at least 8 characters.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <Label>
                Current password
                <Input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
              </Label>
              <Label>
                New password
                <Input
                  type="password"
                  minLength={8}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  required
                />
              </Label>
              <ErrorText error={error} />
              {saved && (
                <p className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 className="size-4" /> Password changed.
                </p>
              )}
              <Button type="submit">Change password</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}
