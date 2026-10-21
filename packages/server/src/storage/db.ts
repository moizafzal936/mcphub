import { createClient, type Client, type InStatement } from '@libsql/client'
import { dirname } from 'path'
import { mkdirSync } from 'fs'
import { nanoid } from 'nanoid'
import { getConfig } from '../config.js'
import type { App, McpTool, McpToken, ToolCallLog, User } from '../types/index.js'
import { appSecretContext, decryptSecret, encryptSecret, isEncrypted } from '../security/secrets.js'

let client: Client | undefined

export function getDb(): Client {
  if (!client) {
    const { dbPath } = getConfig()
    mkdirSync(dirname(dbPath), { recursive: true })
    client = createClient({ url: `file:${dbPath}` })
  }
  return client
}

export function closeDb(): void {
  client?.close()
  client = undefined
}

async function columns(table: string): Promise<Set<string>> {
  const res = await getDb().execute(`PRAGMA table_info(${table})`)
  return new Set(res.rows.map(r => String(r.name)))
}

export async function migrate(): Promise<{ encryptedLegacySecrets: number; orphanApps: number }> {
  const db = getDb()
  // WAL lets readers proceed during writes; busy_timeout waits instead of failing with SQLITE_BUSY.
  await db.execute('PRAGMA journal_mode = WAL')
  await db.execute('PRAGMA busy_timeout = 5000')
  await db.execute('PRAGMA synchronous = NORMAL')

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      spec_url TEXT,
      api_key TEXT,
      api_key_header TEXT NOT NULL DEFAULT 'Authorization',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_tools (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      parameters TEXT NOT NULL DEFAULT '[]',
      request_body_schema TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS tool_call_logs (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      called_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      info TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_requests (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      state TEXT,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS oauth_grants (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      refresh_hash TEXT NOT NULL UNIQUE,
      prev_refresh_hash TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tools_app_id ON mcp_tools(app_id);
    CREATE INDEX IF NOT EXISTS idx_grants_app ON oauth_grants(app_id);
    CREATE INDEX IF NOT EXISTS idx_logs_app_id ON tool_call_logs(app_id, called_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_app ON mcp_tokens(app_id);
  `)

  const appCols = await columns('apps')
  if (!appCols.has('owner_id')) await db.execute('ALTER TABLE apps ADD COLUMN owner_id TEXT')
  if (!appCols.has('rate_limit_per_min')) await db.execute('ALTER TABLE apps ADD COLUMN rate_limit_per_min INTEGER')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_apps_owner ON apps(owner_id)')
  const userCols = await columns('users')
  if (!userCols.has('totp_secret')) await db.execute('ALTER TABLE users ADD COLUMN totp_secret TEXT')
  if (!userCols.has('totp_enabled')) await db.execute('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0')
  if (!userCols.has('totp_last_step')) await db.execute('ALTER TABLE users ADD COLUMN totp_last_step INTEGER')
  const tokenCols = await columns('mcp_tokens')
  if (!tokenCols.has('kind')) await db.execute("ALTER TABLE mcp_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'api'")
  if (!tokenCols.has('grant_id')) await db.execute('ALTER TABLE mcp_tokens ADD COLUMN grant_id TEXT')

  // Encrypt any credentials stored in plaintext by earlier versions (idempotent).
  const legacy = await db.execute("SELECT id, api_key FROM apps WHERE api_key IS NOT NULL AND api_key NOT LIKE 'enc:v1:%'")
  const updates: InStatement[] = legacy.rows.map(r => ({
    sql: 'UPDATE apps SET api_key = ? WHERE id = ?',
    args: [encryptSecret(String(r.api_key), appSecretContext(String(r.id))), String(r.id)],
  }))
  if (updates.length) await db.batch(updates, 'write')

  const orphans = await db.execute('SELECT COUNT(*) AS n FROM apps WHERE owner_id IS NULL')
  return { encryptedLegacySecrets: updates.length, orphanApps: Number(orphans.rows[0].n) }
}

// ── Users & sessions ───────────────────────────────────────────────────────────

export const userRepo = {
  async count(): Promise<number> {
    const res = await getDb().execute('SELECT COUNT(*) AS n FROM users')
    return Number(res.rows[0].n)
  },

  async findByEmail(email: string): Promise<(User & { passwordHash: string }) | undefined> {
    const res = await getDb().execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] })
    const r = res.rows[0]
    return r ? { id: String(r.id), email: String(r.email), createdAt: Number(r.created_at), passwordHash: String(r.password_hash) } : undefined
  },

  async findById(id: string): Promise<User | undefined> {
    const res = await getDb().execute({ sql: 'SELECT id, email, created_at FROM users WHERE id = ?', args: [id] })
    const r = res.rows[0]
    return r ? { id: String(r.id), email: String(r.email), createdAt: Number(r.created_at) } : undefined
  },

  async getTotp(userId: string): Promise<{ secret?: string; enabled: boolean }> {
    const res = await getDb().execute({ sql: 'SELECT totp_secret, totp_enabled FROM users WHERE id = ?', args: [userId] })
    const r = res.rows[0]
    if (!r) return { enabled: false }
    return {
      secret: r.totp_secret == null ? undefined : decryptSecret(String(r.totp_secret), `totp:${userId}`),
      enabled: Number(r.totp_enabled) === 1,
    }
  },

  async setTotpPending(userId: string, secret: string): Promise<void> {
    await getDb().execute({
      sql: 'UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = NULL WHERE id = ?',
      args: [encryptSecret(secret, `totp:${userId}`), userId],
    })
  },

  /** Records a used TOTP step; false if that step (or a later one) was already used (replay). */
  async consumeTotpStep(userId: string, step: number, enable = false): Promise<boolean> {
    const res = await getDb().execute({
      sql: `UPDATE users SET totp_last_step = ?${enable ? ', totp_enabled = 1' : ''}
            WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
      args: [step, userId, step],
    })
    return res.rowsAffected === 1
  },

  async disableTotp(userId: string): Promise<void> {
    await getDb().execute({ sql: 'UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?', args: [userId] })
  },

  /** Sets a new password and signs the user out everywhere. */
  async resetPassword(userId: string, passwordHash: string): Promise<void> {
    await getDb().batch([
      { sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [passwordHash, userId] },
      { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [userId] },
    ], 'write')
  },

  /** The operator is the first account created on this server. */
  async operatorId(): Promise<string | undefined> {
    const res = await getDb().execute('SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1')
    return res.rows[0] ? String(res.rows[0].id) : undefined
  },

  /** Inserts only if signup is allowed at commit time, so two racing "first user" signups can't both succeed. */
  async insertIf(user: User & { passwordHash: string }, onlyIfNoUsers: boolean): Promise<boolean> {
    const res = await getDb().execute({
      sql: `INSERT INTO users (id, email, password_hash, created_at)
            SELECT ?, ?, ?, ? WHERE ${onlyIfNoUsers ? 'NOT EXISTS (SELECT 1 FROM users)' : '1'}`,
      args: [user.id, user.email, user.passwordHash, user.createdAt],
    })
    return res.rowsAffected === 1
  },
}

export const sessionRepo = {
  async insert(tokenHash: string, userId: string, ttlMs: number): Promise<void> {
    const now = Date.now()
    await getDb().execute({
      sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      args: [tokenHash, userId, now, now + ttlMs],
    })
  },

  async findValid(tokenHash: string): Promise<{ userId: string } | undefined> {
    const res = await getDb().execute({
      sql: 'SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?',
      args: [tokenHash, Date.now()],
    })
    return res.rows[0] ? { userId: String(res.rows[0].user_id) } : undefined
  },

  async delete(tokenHash: string): Promise<void> {
    await getDb().execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [tokenHash] })
  },
}

// ── Apps ───────────────────────────────────────────────────────────────────────

function rowToApp(row: any): App {
  return {
    id: String(row.id),
    ownerId: row.owner_id == null ? null : String(row.owner_id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    specUrl: row.spec_url == null ? undefined : String(row.spec_url),
    apiKeyHeader: String(row.api_key_header),
    hasApiKey: row.api_key != null && String(row.api_key) !== '',
    rateLimitPerMin: row.rate_limit_per_min == null ? null : Number(row.rate_limit_per_min),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export const appRepo = {
  async findAllForOwner(ownerId: string): Promise<App[]> {
    const res = await getDb().execute({ sql: 'SELECT * FROM apps WHERE owner_id = ? ORDER BY created_at DESC', args: [ownerId] })
    return res.rows.map(rowToApp)
  },

  async findForOwner(id: string, ownerId: string): Promise<App | undefined> {
    const res = await getDb().execute({ sql: 'SELECT * FROM apps WHERE id = ? AND owner_id = ?', args: [id, ownerId] })
    return res.rows[0] ? rowToApp(res.rows[0]) : undefined
  },

  async insert(app: App, apiKey: string | undefined): Promise<void> {
    await getDb().execute({
      sql: `INSERT INTO apps (id, owner_id, name, base_url, spec_url, api_key, api_key_header, rate_limit_per_min, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        app.id, app.ownerId, app.name, app.baseUrl, app.specUrl ?? null,
        apiKey ? encryptSecret(apiKey, appSecretContext(app.id)) : null,
        app.apiKeyHeader, app.rateLimitPerMin, app.createdAt, app.updatedAt,
      ],
    })
  },

  async update(id: string, ownerId: string, patch: { name?: string; apiKey?: string | null; apiKeyHeader?: string; rateLimitPerMin?: number | null }): Promise<void> {
    const sets: string[] = []
    const args: (string | number | null)[] = []
    if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name) }
    if (patch.apiKeyHeader !== undefined) { sets.push('api_key_header = ?'); args.push(patch.apiKeyHeader) }
    if (patch.rateLimitPerMin !== undefined) { sets.push('rate_limit_per_min = ?'); args.push(patch.rateLimitPerMin) }
    if (patch.apiKey !== undefined) {
      sets.push('api_key = ?')
      args.push(patch.apiKey ? encryptSecret(patch.apiKey, appSecretContext(id)) : null)
    }
    if (!sets.length) return
    sets.push('updated_at = ?')
    args.push(Date.now(), id, ownerId)
    await getDb().execute({ sql: `UPDATE apps SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`, args })
  },

  /** Decrypts the app's upstream credential. Only the executor should call this. */
  async getApiKey(appId: string): Promise<string | undefined> {
    const res = await getDb().execute({ sql: 'SELECT api_key FROM apps WHERE id = ?', args: [appId] })
    const stored = res.rows[0]?.api_key
    if (stored == null || stored === '') return undefined
    const value = String(stored)
    if (!isEncrypted(value)) throw new Error('Credential is not encrypted at rest; restart to run the migration')
    return decryptSecret(value, appSecretContext(appId))
  },

  async deleteForOwner(id: string, ownerId: string): Promise<boolean> {
    const db = getDb()
    const res = await db.execute({ sql: 'SELECT id FROM apps WHERE id = ? AND owner_id = ?', args: [id, ownerId] })
    if (!res.rows[0]) return false
    await db.batch([
      { sql: 'DELETE FROM mcp_tools WHERE app_id = ?', args: [id] },
      { sql: 'DELETE FROM tool_call_logs WHERE app_id = ?', args: [id] },
      { sql: 'DELETE FROM mcp_tokens WHERE app_id = ?', args: [id] },
      { sql: 'DELETE FROM oauth_grants WHERE app_id = ?', args: [id] },
      { sql: 'DELETE FROM oauth_codes WHERE app_id = ?', args: [id] },
      { sql: 'DELETE FROM oauth_requests WHERE app_id = ?', args: [id] },
      { sql: 'DELETE FROM apps WHERE id = ? AND owner_id = ?', args: [id, ownerId] },
    ], 'write')
    return true
  },

  async countOrphans(): Promise<number> {
    const res = await getDb().execute('SELECT COUNT(*) AS n FROM apps WHERE owner_id IS NULL')
    return Number(res.rows[0].n)
  },

  async assignOrphansTo(ownerId: string): Promise<number> {
    const res = await getDb().execute({ sql: 'UPDATE apps SET owner_id = ? WHERE owner_id IS NULL', args: [ownerId] })
    return res.rowsAffected
  },
}

// ── Tools (every query is scoped by app id) ────────────────────────────────────

function rowToTool(row: any): McpTool {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    name: String(row.name),
    description: String(row.description),
    method: String(row.method) as McpTool['method'],
    path: String(row.path),
    parameters: JSON.parse(String(row.parameters)),
    requestBodySchema: row.request_body_schema ? JSON.parse(String(row.request_body_schema)) : undefined,
    enabled: Number(row.enabled) === 1,
  }
}

export const toolRepo = {
  async findEnabledByAppId(appId: string): Promise<McpTool[]> {
    const res = await getDb().execute({ sql: 'SELECT * FROM mcp_tools WHERE app_id = ? AND enabled = 1 ORDER BY name', args: [appId] })
    return res.rows.map(rowToTool)
  },

  async findAllByAppId(appId: string): Promise<McpTool[]> {
    const res = await getDb().execute({ sql: 'SELECT * FROM mcp_tools WHERE app_id = ? ORDER BY name', args: [appId] })
    return res.rows.map(rowToTool)
  },

  async countByAppId(appId: string): Promise<number> {
    const res = await getDb().execute({ sql: 'SELECT COUNT(*) AS n FROM mcp_tools WHERE app_id = ?', args: [appId] })
    return Number(res.rows[0].n)
  },

  async findInApp(appId: string, toolId: string): Promise<McpTool | undefined> {
    const res = await getDb().execute({ sql: 'SELECT * FROM mcp_tools WHERE id = ? AND app_id = ?', args: [toolId, appId] })
    return res.rows[0] ? rowToTool(res.rows[0]) : undefined
  },

  async findByNameInApp(appId: string, name: string): Promise<McpTool | undefined> {
    const res = await getDb().execute({ sql: 'SELECT * FROM mcp_tools WHERE app_id = ? AND name = ?', args: [appId, name] })
    return res.rows[0] ? rowToTool(res.rows[0]) : undefined
  },

  async insertMany(tools: McpTool[]): Promise<void> {
    if (!tools.length) return
    await getDb().batch(tools.map(t => ({
      sql: `INSERT INTO mcp_tools (id, app_id, name, description, method, path, parameters, request_body_schema, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        t.id, t.appId, t.name, t.description, t.method, t.path,
        JSON.stringify(t.parameters),
        t.requestBodySchema ? JSON.stringify(t.requestBodySchema) : null,
        t.enabled ? 1 : 0,
      ],
    })), 'write')
  },

  async replaceAllForApp(appId: string, tools: McpTool[]): Promise<void> {
    await getDb().batch([
      { sql: 'DELETE FROM mcp_tools WHERE app_id = ?', args: [appId] },
      ...tools.map(t => ({
        sql: `INSERT INTO mcp_tools (id, app_id, name, description, method, path, parameters, request_body_schema, enabled)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          t.id, appId, t.name, t.description, t.method, t.path,
          JSON.stringify(t.parameters),
          t.requestBodySchema ? JSON.stringify(t.requestBodySchema) : null,
          t.enabled ? 1 : 0,
        ],
      })),
    ], 'write')
  },

  async updateInApp(appId: string, toolId: string, patch: { enabled?: boolean; name?: string; description?: string }): Promise<boolean> {
    const sets: string[] = []
    const args: (string | number)[] = []
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0) }
    if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name) }
    if (patch.description !== undefined) { sets.push('description = ?'); args.push(patch.description) }
    if (!sets.length) return true
    args.push(toolId, appId)
    const res = await getDb().execute({ sql: `UPDATE mcp_tools SET ${sets.join(', ')} WHERE id = ? AND app_id = ?`, args })
    return res.rowsAffected === 1
  },

  async deleteInApp(appId: string, toolId: string): Promise<boolean> {
    const res = await getDb().execute({ sql: 'DELETE FROM mcp_tools WHERE id = ? AND app_id = ?', args: [toolId, appId] })
    return res.rowsAffected === 1
  },
}

// ── MCP access tokens ──────────────────────────────────────────────────────────

function rowToToken(r: any): McpToken {
  return {
    id: String(r.id),
    appId: String(r.app_id),
    userId: String(r.user_id),
    name: String(r.name),
    prefix: String(r.prefix),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
  }
}

export const tokenRepo = {
  async insert(t: McpToken, tokenHash: string, oauth?: { grantId: string }): Promise<void> {
    await getDb().execute({
      sql: `INSERT INTO mcp_tokens (id, app_id, user_id, name, token_hash, prefix, created_at, expires_at, kind, grant_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [t.id, t.appId, t.userId, t.name, tokenHash, t.prefix, t.createdAt, t.expiresAt, oauth ? 'oauth' : 'api', oauth?.grantId ?? null],
    })
  },

  async listForApp(appId: string): Promise<McpToken[]> {
    const res = await getDb().execute({ sql: "SELECT * FROM mcp_tokens WHERE app_id = ? AND kind = 'api' ORDER BY created_at DESC", args: [appId] })
    return res.rows.map(rowToToken)
  },

  /** Active token whose app still exists, is owned by the token's user, and (for OAuth) whose grant is live. */
  async findActiveByHash(tokenHash: string): Promise<(McpToken & { grantId: string | null }) | undefined> {
    const res = await getDb().execute({
      sql: `SELECT t.* FROM mcp_tokens t
            JOIN apps a ON a.id = t.app_id AND a.owner_id = t.user_id
            LEFT JOIN oauth_grants g ON g.id = t.grant_id
            WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
              AND (t.grant_id IS NULL OR (g.revoked_at IS NULL AND g.user_id = t.user_id))`,
      args: [tokenHash, Date.now()],
    })
    if (!res.rows[0]) return undefined
    return { ...rowToToken(res.rows[0]), grantId: res.rows[0].grant_id == null ? null : String(res.rows[0].grant_id) }
  },

  async revokeInApp(appId: string, tokenId: string): Promise<boolean> {
    const res = await getDb().execute({
      sql: 'UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND app_id = ? AND revoked_at IS NULL',
      args: [Date.now(), tokenId, appId],
    })
    return res.rowsAffected === 1
  },

  async touch(tokenId: string): Promise<void> {
    await getDb().execute({
      sql: 'UPDATE mcp_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
      args: [Date.now(), tokenId, Date.now() - 60_000],
    })
  },
}

// ── Logs ───────────────────────────────────────────────────────────────────────

function rowToLog(row: any): ToolCallLog {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    toolName: String(row.tool_name),
    input: JSON.parse(String(row.input)),
    output: JSON.parse(String(row.output)),
    statusCode: Number(row.status_code),
    durationMs: Number(row.duration_ms),
    calledAt: Number(row.called_at),
  }
}

export const logRepo = {
  async insert(log: ToolCallLog): Promise<void> {
    await getDb().execute({
      sql: `INSERT INTO tool_call_logs (id, app_id, tool_name, input, output, status_code, duration_ms, called_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [log.id, log.appId, log.toolName, JSON.stringify(log.input ?? null), JSON.stringify(log.output ?? null), log.statusCode, log.durationMs, log.calledAt],
    })
  },

  async findByAppId(appId: string, limit = 50): Promise<ToolCallLog[]> {
    const res = await getDb().execute({
      sql: 'SELECT * FROM tool_call_logs WHERE app_id = ? ORDER BY called_at DESC LIMIT ?',
      args: [appId, limit],
    })
    return res.rows.map(rowToLog)
  },

  async lastCalledAt(appId: string): Promise<number | null> {
    const res = await getDb().execute({ sql: 'SELECT MAX(called_at) AS t FROM tool_call_logs WHERE app_id = ?', args: [appId] })
    return res.rows[0]?.t == null ? null : Number(res.rows[0].t)
  },
}

/** Bounded retention: drop logs older than the window, cap rows per app, clear expired sessions. */
export async function purgeExpired(retentionDays: number, maxPerApp: number): Promise<{ logs: number; sessions: number }> {
  const db = getDb()
  const cutoff = Date.now() - retentionDays * 86_400_000
  const aged = await db.execute({ sql: 'DELETE FROM tool_call_logs WHERE called_at < ?', args: [cutoff] })
  const capped = await db.execute({
    sql: `DELETE FROM tool_call_logs WHERE id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY called_at DESC) AS rn FROM tool_call_logs
            ) WHERE rn > ?
          )`,
    args: [maxPerApp],
  })
  const sessions = await db.execute({ sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [Date.now()] })
  const now = Date.now()
  await db.batch([
    { sql: 'DELETE FROM oauth_requests WHERE expires_at < ?', args: [now] },
    { sql: 'DELETE FROM oauth_codes WHERE expires_at < ?', args: [now - 86_400_000] },
    { sql: 'DELETE FROM mcp_tokens WHERE kind = ? AND expires_at < ?', args: ['oauth', now - 86_400_000] },
    // Dynamically registered OAuth clients with no live grant after 30 days.
    {
      sql: `DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN
              (SELECT client_id FROM oauth_grants WHERE revoked_at IS NULL AND expires_at > ?)`,
      args: [now - 30 * 86_400_000, now],
    },
  ], 'write')
  return { logs: aged.rowsAffected + capped.rowsAffected, sessions: sessions.rowsAffected }
}

export function newId(): string {
  return nanoid()
}
