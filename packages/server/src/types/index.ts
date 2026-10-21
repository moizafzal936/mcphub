export interface App {
  id: string
  ownerId: string | null
  name: string
  baseUrl: string
  specUrl?: string
  apiKeyHeader: string
  hasApiKey: boolean
  rateLimitPerMin: number | null
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
