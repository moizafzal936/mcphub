import axios from 'axios'

const http = axios.create({ baseURL: '/api', withCredentials: true })

// Any 401 outside the auth endpoints means the session expired: send the user to sign in.
http.interceptors.response.use(
  r => r,
  err => {
    const url: string = err.config?.url ?? ''
    if (err.response?.status === 401 && !url.startsWith('/auth/') && window.location.pathname !== '/login') {
      const next = encodeURIComponent(window.location.pathname + window.location.search)
      window.location.assign(`/login?next=${next}`)
    }
    return Promise.reject(err)
  }
)

export function apiError(err: any): string {
  const data = err?.response?.data
  const fieldErrors = data?.details?.fieldErrors
  if (fieldErrors) {
    const [field, msgs] = Object.entries(fieldErrors as Record<string, string[]>)[0] ?? []
    if (field && msgs?.length) return `${field}: ${msgs[0]}`
  }
  return data?.error ?? err?.message ?? 'Request failed'
}

export interface User {
  id: string
  email: string
  twoFactorEnabled?: boolean
}

export interface App {
  id: string
  name: string
  baseUrl: string
  specUrl?: string
  apiKeyHeader: string
  apiKeyIn?: 'header' | 'query'
  authType?: 'api_key' | 'oauth2_client_credentials'
  oauth?: { tokenUrl: string; clientId: string; scope?: string; audience?: string; clientAuth: 'basic' | 'post' }
  fixedParams?: { in: 'header' | 'query'; name: string; secret: boolean; value?: string; hasValue?: boolean }[]
  hasApiKey: boolean
  rateLimitPerMin: number | null
  readOnly?: boolean
  createdAt: number
  updatedAt: number
  toolCount?: number
  lastUsed?: number | null
  warning?: string
}

export interface ToolParameter {
  name: string
  in: 'query' | 'path' | 'header' | 'body'
  description: string
  required: boolean
  schema: { type: string; enum?: (string | number | boolean)[] }
}

export interface McpTool {
  id: string
  appId: string
  name: string
  description: string
  method: string
  path: string
  parameters: ToolParameter[]
  requestBodySchema?: Record<string, unknown>
  responseFields?: string[]
  enabled: boolean
}

export interface ReadinessIssue {
  id: string
  severity: 'high' | 'medium' | 'low' | 'info'
  title: string
  detail: string
  tools: string[]
}

export interface Readiness {
  score: number
  grade: 'great' | 'good' | 'needs-work'
  exposed: number
  issues: ReadinessIssue[]
}

/** Every argument an AI client fills in: path/query/header parameters plus top-level body fields. */
export function argumentFields(tool: McpTool): { name: string; in: string; description: string }[] {
  const fields = tool.parameters.map(p => ({ name: p.name, in: p.in, description: p.description ?? '' }))
  const body = (tool.requestBodySchema as any)?.properties
  if (body && typeof body === 'object') {
    for (const [name, schema] of Object.entries<any>(body)) {
      if (!fields.some(f => f.name === name)) fields.push({ name, in: 'body', description: typeof schema?.description === 'string' ? schema.description : '' })
    }
  }
  return fields
}

export interface ToolCallLog {
  id: string
  toolName: string
  input: unknown
  output: unknown
  statusCode: number
  durationMs: number
  calledAt: number
}

export interface McpToken {
  id: string
  name: string
  prefix: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export interface OAuthGrant {
  id: string
  clientName: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number
  revokedAt: number | null
}

export interface ConsentRequest {
  clientName: string
  redirectHost: string
  app: { id: string; name: string; baseUrl: string }
  scopes: string[]
}

export interface PlaygroundStep {
  tool: string
  input: unknown
  statusCode: number
  durationMs: number
}

export interface ExecResult {
  data: unknown
  statusCode: number
  durationMs: number
  text: string
  error?: string
  request?: { method: string; url: string }
  /** `text` (what AI clients get) was cut down to the tool's response fields. */
  shaped?: boolean
}

export const api = {
  auth: {
    status: () => http.get<{ signupOpen: boolean; bootstrap: boolean; needsSetup?: boolean }>('/auth/status').then(r => r.data),
    me: () => http.get<{ user: User }>('/auth/me').then(r => r.data.user),
    login: (email: string, password: string, code?: string) =>
      http.post<{ user: User }>('/auth/login', { email, password, ...(code ? { code } : {}) }).then(r => r.data.user),
    twoFactorSetup: () => http.post<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup').then(r => r.data),
    twoFactorEnable: (code: string) => http.post('/auth/2fa/enable', { code }).then(r => r.data),
    twoFactorDisable: (password: string, code: string) => http.post('/auth/2fa/disable', { password, code }).then(r => r.data),
    register: (email: string, password: string) => http.post<{ user: User }>('/auth/register', { email, password }).then(r => r.data.user),
    logout: () => http.post('/auth/logout').then(r => r.data),
  },
  apps: {
    list: () => http.get<App[]>('/apps').then(r => r.data),
    get: (id: string) => http.get<App>(`/apps/${id}`).then(r => r.data),
    create: (data: {
      name: string
      baseUrl: string
      specUrl?: string
      apiKey?: string
      apiKeyHeader?: string
      apiKeyIn?: 'header' | 'query'
      authType?: App['authType']
      oauth?: App['oauth']
    }) => http.post<App>('/apps', data).then(r => r.data),
    update: (id: string, patch: { name?: string; apiKey?: string | null; apiKeyHeader?: string; apiKeyIn?: 'header' | 'query'; authType?: App['authType']; oauth?: App['oauth']; fixedParams?: { in: 'header' | 'query'; name: string; secret: boolean; value: string | null }[]; rateLimitPerMin?: number | null; readOnly?: boolean }) =>
      http.patch<App>(`/apps/${id}`, patch).then(r => r.data),
    delete: (id: string) => http.delete(`/apps/${id}`).then(r => r.data),
    import: (id: string, specUrl?: string) =>
      http.post<{ imported: number; tools: McpTool[]; format?: 'openapi' | 'postman'; skipped?: string[] }>(`/apps/${id}/import`, specUrl ? { specUrl } : {}).then(r => r.data),
    testAuth: (id: string) =>
      http.post<{ ok: boolean; error?: string; tokenType?: string; expiresIn?: number; scope?: string }>(`/apps/${id}/auth/test`).then(r => r.data),
    exportConfig: (id: string) => http.get<Record<string, unknown>>(`/apps/${id}/export`).then(r => r.data),
    importConfig: (config: string) =>
      http.post<App & { skipped: string[] }>('/apps/import-config', config, { headers: { 'Content-Type': 'text/plain' } }).then(r => r.data),
    importSpecText: (id: string, spec: string) =>
      http.post<{ imported: number; tools: McpTool[]; format?: 'openapi' | 'postman'; skipped?: string[] }>(`/apps/${id}/import-spec`, spec, { headers: { 'Content-Type': 'text/plain' }, timeout: 60_000 }).then(r => r.data),
  },
  tools: {
    list: (appId: string) => http.get<McpTool[]>(`/apps/${appId}/tools`).then(r => r.data),
    create: (appId: string, data: {
      name: string
      description?: string
      method: string
      path: string
      queryParams?: { name: string; description: string; required: boolean; in?: 'query' | 'header' | 'body'; type?: string }[]
    }) => http.post<McpTool>(`/apps/${appId}/tools`, data).then(r => r.data),
    fromCurl: (appId: string, curl: string, name?: string) =>
      http.post<{ tool: McpTool; skippedHeaders: string[]; usedBasicAuth: boolean }>(`/apps/${appId}/tools/from-curl`, { curl, ...(name ? { name } : {}) }).then(r => r.data),
    toggle: (appId: string, toolId: string, enabled: boolean) =>
      http.patch(`/apps/${appId}/tools/${toolId}`, { enabled }).then(r => r.data),
    updateMeta: (appId: string, toolId: string, data: { name?: string; description?: string; parameterDescriptions?: Record<string, string> }) =>
      http.patch(`/apps/${appId}/tools/${toolId}`, data).then(r => r.data),
    delete: (appId: string, toolId: string) =>
      http.delete(`/apps/${appId}/tools/${toolId}`).then(r => r.data),
    setResponseFields: (appId: string, toolId: string, responseFields: string[] | null) =>
      http.patch(`/apps/${appId}/tools/${toolId}`, { responseFields }).then(r => r.data),
    readiness: (appId: string) => http.get<Readiness>(`/apps/${appId}/readiness`).then(r => r.data),
    stats: (appId: string) =>
      http.get<{ toolName: string; calls: number; errors: number; avgMs: number; lastCalledAt: number }[]>(`/apps/${appId}/tool-stats`).then(r => r.data),
    execute: (appId: string, toolId: string, args: Record<string, unknown>) =>
      http.post<ExecResult>(`/apps/${appId}/tools/${toolId}/execute`, args).then(r => r.data),
  },
  tokens: {
    list: (appId: string) => http.get<McpToken[]>(`/apps/${appId}/tokens`).then(r => r.data),
    create: (appId: string, name: string) =>
      http.post<McpToken & { token: string }>(`/apps/${appId}/tokens`, { name }).then(r => r.data),
    revoke: (appId: string, tokenId: string) => http.delete(`/apps/${appId}/tokens/${tokenId}`).then(r => r.data),
  },
  playground: {
    status: () => http.get<{ enabled: boolean }>('/playground/status').then(r => r.data),
    run: (appId: string, messages: { role: 'user' | 'assistant'; content: string }[]) =>
      http.post<{ reply: string; steps: PlaygroundStep[] }>(`/apps/${appId}/playground`, { messages }, { timeout: 120_000 }).then(r => r.data),
  },
  orphans: {
    status: () => http.get<{ count: number; canClaim: boolean }>('/orphans').then(r => r.data),
    claim: () => http.post<{ claimed: number }>('/orphans/claim').then(r => r.data),
  },
  grants: {
    list: (appId: string) => http.get<OAuthGrant[]>(`/apps/${appId}/grants`).then(r => r.data),
    revoke: (appId: string, grantId: string) => http.delete(`/apps/${appId}/grants/${grantId}`).then(r => r.data),
  },
  oauth: {
    request: (id: string) => http.get<ConsentRequest>(`/oauth/requests/${encodeURIComponent(id)}`).then(r => r.data),
    decide: (id: string, approve: boolean) =>
      http.post<{ redirectUrl: string }>(`/oauth/requests/${encodeURIComponent(id)}/decision`, { approve }).then(r => r.data),
  },
  stats: {
    get: () => http.get<{ apps: number; tools: number; mcpEndpoints: number }>('/stats').then(r => r.data),
  },
  logs: {
    list: (appId: string) => http.get<ToolCallLog[]>(`/apps/${appId}/logs`).then(r => r.data),
  },
}
