import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface Config {
  env: 'production' | 'development' | 'test'
  isProduction: boolean
  port: number
  dataDir: string
  dbPath: string
  encryptionKey?: string
  cookieSecure: boolean
  allowSignup: boolean
  trustProxy: string | false
  allowedOrigins: string[]
  publicUrl?: string
  ssrfAllow: string[]
  rate: {
    appPerMin: number
    clientPerMin: number
    authPer15Min: number
    apiPerMin: number
    sseConnectPerMin: number
  }
  maxSsePerApp: number
  maxSseTotal: number
  logRetentionDays: number
  logMaxPerApp: number
  mcpTokenDefaultDays: number
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`)
  return n
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development'
  const isProduction = nodeEnv === 'production'
  const dataDir = env.MCPHUB_DATA_DIR ?? join(__dirname, '../data')

  const config: Config = {
    env: nodeEnv,
    isProduction,
    port: int(env.PORT, 3001, 'PORT'),
    dataDir,
    dbPath: env.MCPHUB_DB_PATH ?? join(dataDir, 'mcpify.db'),
    encryptionKey: env.MCPHUB_ENCRYPTION_KEY || undefined,
    cookieSecure: env.MCPHUB_COOKIE_SECURE ? env.MCPHUB_COOKIE_SECURE === 'true' : isProduction,
    allowSignup: env.MCPHUB_ALLOW_SIGNUP === 'true',
    trustProxy: env.MCPHUB_TRUST_PROXY || false,
    allowedOrigins: list(env.MCPHUB_ALLOWED_ORIGINS),
    publicUrl: env.MCPHUB_PUBLIC_URL?.replace(/\/+$/, '') || undefined,
    ssrfAllow: list(env.MCPHUB_SSRF_ALLOW),
    rate: {
      appPerMin: int(env.MCPHUB_RATE_APP_PER_MIN, 120, 'MCPHUB_RATE_APP_PER_MIN'),
      clientPerMin: int(env.MCPHUB_RATE_CLIENT_PER_MIN, 60, 'MCPHUB_RATE_CLIENT_PER_MIN'),
      authPer15Min: int(env.MCPHUB_RATE_AUTH_PER_15MIN, 10, 'MCPHUB_RATE_AUTH_PER_15MIN'),
      apiPerMin: int(env.MCPHUB_RATE_API_PER_MIN, 300, 'MCPHUB_RATE_API_PER_MIN'),
      sseConnectPerMin: int(env.MCPHUB_RATE_SSE_CONNECT_PER_MIN, 30, 'MCPHUB_RATE_SSE_CONNECT_PER_MIN'),
    },
    maxSsePerApp: int(env.MCPHUB_MAX_SSE_PER_APP, 10, 'MCPHUB_MAX_SSE_PER_APP'),
    maxSseTotal: int(env.MCPHUB_MAX_SSE_TOTAL, 200, 'MCPHUB_MAX_SSE_TOTAL'),
    logRetentionDays: int(env.MCPHUB_LOG_RETENTION_DAYS, 30, 'MCPHUB_LOG_RETENTION_DAYS'),
    logMaxPerApp: int(env.MCPHUB_LOG_MAX_PER_APP, 1000, 'MCPHUB_LOG_MAX_PER_APP'),
    mcpTokenDefaultDays: int(env.MCPHUB_MCP_TOKEN_DAYS, 90, 'MCPHUB_MCP_TOKEN_DAYS'),
  }

  if (isProduction) {
    const missing: string[] = []
    if (!config.publicUrl?.startsWith('https://')) missing.push('MCPHUB_PUBLIC_URL (https origin; used as the OAuth issuer)')
    if (!config.encryptionKey) missing.push('MCPHUB_ENCRYPTION_KEY (32 random bytes, base64)')
    if (!config.cookieSecure) missing.push('MCPHUB_COOKIE_SECURE must not be false in production (serve over HTTPS)')
    if (missing.length) {
      throw new Error(`Refusing to start in production. Missing/invalid configuration:\n  - ${missing.join('\n  - ')}`)
    }
  }

  return config
}

/** OAuth issuer and MCP resource origin. */
export function issuerUrl(config: Config = getConfig()): string {
  return config.publicUrl ?? `http://localhost:${config.port}`
}

/** Where the dashboard (and its OAuth consent page) is served. */
export function dashboardUrl(config: Config = getConfig()): string {
  return (process.env.MCPHUB_DASHBOARD_URL || config.publicUrl || 'http://localhost:3000').replace(/\/+$/, '')
}

let cached: Config | undefined

export function getConfig(): Config {
  if (!cached) cached = loadConfig()
  return cached
}
