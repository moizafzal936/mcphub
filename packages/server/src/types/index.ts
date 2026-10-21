export interface OAuthClientConfig {
  tokenUrl: string
  clientId: string
  scope?: string
  audience?: string
  /** How the client secret is sent to the token endpoint: HTTP Basic (default) or form body. */
  clientAuth: 'basic' | 'post'
}

/** A header or query parameter sent on every call (API version, tenant id, a second credential). */
export interface FixedParam {
  in: 'header' | 'query'
  name: string
  secret: boolean
  /** Omitted for secret params outside the storage layer; `hasValue` says whether one is stored. */
  value?: string
  hasValue?: boolean
}

export interface App {
  id: string
  ownerId: string | null
  name: string
  baseUrl: string
  specUrl?: string
  /** Name of the header or query parameter that carries the upstream credential. */
  apiKeyHeader: string
  apiKeyIn: 'header' | 'query'
  /** api_key: the stored secret is sent as-is. oauth2_client_credentials: it is the client secret used to fetch tokens. */
  authType: 'api_key' | 'oauth2_client_credentials'
  oauth?: OAuthClientConfig
  fixedParams: FixedParam[]
  hasApiKey: boolean
  rateLimitPerMin: number | null
  readOnly: boolean
  createdAt: number
  updatedAt: number
}

export interface McpTool {
  id: string
  appId: string
  name: string
  description: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  parameters: ToolParameter[]
  requestBodySchema?: Record<string, unknown>
  /** Dotted paths kept in successful responses sent to AI clients (arrays are traversed). */
  responseFields?: string[]
  enabled: boolean
}

export interface ToolParameter {
  name: string
  in: 'query' | 'path' | 'header'
  description: string
  required: boolean
  schema: { type: string; enum?: (string | number | boolean)[] }
}

export interface ToolCallLog {
  id: string
  appId: string
  toolName: string
  input: unknown
  output: unknown
  statusCode: number
  durationMs: number
  calledAt: number
}

export interface User {
  id: string
  email: string
  createdAt: number
}

export interface McpToken {
  id: string
  appId: string
  userId: string
  name: string
  prefix: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}
