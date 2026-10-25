// Every call to the gateway API goes through `api()`.
// The login cookie is httpOnly, so this code never sees it: the browser
// simply sends it along with each same-origin request.

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

type Options = { method?: string; body?: unknown }

export async function api<T = void>(path: string, { method = 'GET', body }: Options = {}): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 204) return undefined as T

  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(errorMessage(data), response.status)
  return data as T
}

// FastAPI errors are {"detail": "text"} or, for invalid input,
// {"detail": [{"loc": [..., "field"], "msg": "..."}]}.
function errorMessage(data: { detail?: unknown }): string {
  if (typeof data.detail === 'string') return data.detail
  if (Array.isArray(data.detail)) {
    return data.detail
      .map((e: { loc?: string[]; msg?: string }) => `${e.loc?.at(-1) ?? 'input'}: ${e.msg}`)
      .join('; ')
  }
  return 'Something went wrong.'
}

// ---------- Shapes returned by the API ----------

export type Me = { id: number; email: string; name: string; role: 'admin' | 'member' }

export type Tool = {
  name: string
  description: string | null
  read_only: boolean
  access: 'everyone' | 'admins'
  overridden: boolean
}

export type Server = {
  id: number
  name: string
  url: string
  auth_type: 'none' | 'bearer' | 'header'
  auth_header: string | null
  has_credential: boolean
  enabled: boolean
  status: 'connected' | 'unreachable' | 'disabled' | 'unknown'
  error: string | null
  checked_at: string | null
  tools: Tool[]
  skipped_tools: string[]
  image: string | null
}

export type TeamMember = {
  id: number
  email: string
  name: string
  role: 'admin' | 'member'
  status: 'active' | 'invited'
  created_at: string
}

export type ApiKey = {
  id: number
  user_id: number
  name: string
  prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export type AuditRow = {
  id: number
  created_at: string
  user_email: string
  source: 'api_key' | 'chat'
  server_name: string
  tool_name: string
  duration_ms: number
  outcome: 'ok' | 'error' | 'timeout' | 'denied'
  error: string | null
}

export type ServerStats = {
  server_name: string
  calls: number
  errors: number
  error_rate: number
  avg_ms: number
  p95_ms: number
}
