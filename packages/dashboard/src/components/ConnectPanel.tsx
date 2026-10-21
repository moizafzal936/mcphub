import { useEffect, useState } from 'react'
import { KeyRound, Loader2, PlugZap, ShieldAlert, Trash2 } from 'lucide-react'
import { api, apiError, type App, type McpToken, type OAuthGrant } from '../lib/api.ts'
import { useToast } from './Toast.tsx'
import { CopyButton } from './CopyButton.tsx'

type ClientKind = 'claude-connector' | 'claude-code' | 'claude-desktop' | 'cursor' | 'curl'

const TOKEN_PLACEHOLDER = '<YOUR_MCP_TOKEN>'

function snippet(kind: ClientKind, name: string, url: string, token: string): string {
  switch (kind) {
    case 'claude-connector':
      return url
    case 'claude-code':
      return `claude mcp add --transport http ${name} ${url}`
    case 'claude-desktop':
      return JSON.stringify({ mcpServers: { [name]: { command: 'npx', args: ['-y', 'mcp-remote', url] } } }, null, 2)
    case 'cursor':
      return JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2)
    case 'curl':
      return [
        `curl -s ${url} \\`,
        `  -H "Authorization: Bearer ${token}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Accept: application/json, text/event-stream" \\`,
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`,
      ].join('\n')
  }
}

const CLIENTS: { key: ClientKind; label: string; hint: string; oauth: boolean }[] = [
  { key: 'claude-connector', label: 'Claude', oauth: true, hint: 'In Claude: Settings → Connectors → Add custom connector, paste this URL, then sign in here and click Allow. Claude must be able to reach the URL, so this needs a public HTTPS deployment.' },
  { key: 'claude-code', label: 'Claude Code', oauth: true, hint: 'Run this, then use /mcp in Claude Code and choose Authenticate. Your browser opens this dashboard to approve.' },
  { key: 'claude-desktop', label: 'Claude Desktop', oauth: true, hint: 'Add to claude_desktop_config.json (Settings → Developer → Edit Config) and restart Claude. A browser window opens to approve access.' },
  { key: 'cursor', label: 'Cursor', oauth: true, hint: 'Add to ~/.cursor/mcp.json. Cursor asks you to sign in the first time it connects.' },
  { key: 'curl', label: 'Scripts (token)', oauth: false, hint: 'For scripts and headless clients: create an access token below. Lists your tools as JSON if the server and token work.' },
]

export function ConnectPanel({ app, mcpUrl }: { app: App; mcpUrl: string }) {
  const { success, error } = useToast()
  const [tokens, setTokens] = useState<McpToken[]>([])
  const [newToken, setNewToken] = useState<string | null>(null)
  const [tokenName, setTokenName] = useState('Claude Desktop')
  const [busy, setBusy] = useState(false)
  const [client, setClient] = useState<ClientKind>('claude-code')
  const [grants, setGrants] = useState<OAuthGrant[]>([])

  const serverName = app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcphub'
  const active = tokens.filter(t => !t.revokedAt && t.expiresAt > Date.now())

  useEffect(() => {
    api.tokens.list(app.id).then(setTokens).catch(() => {})
    api.grants.list(app.id).then(setGrants).catch(() => {})
  }, [app.id])

  async function disconnect(g: OAuthGrant) {
    if (!confirm(`Disconnect ${g.clientName}? It will lose access immediately.`)) return
    try {
      await api.grants.revoke(app.id, g.id)
      setGrants(gs => gs.map(x => (x.id === g.id ? { ...x, revokedAt: Date.now() } : x)))
      success('Disconnected', g.clientName)
    } catch (err) {
      error('Could not disconnect', apiError(err))
    }
  }

  async function create() {
    setBusy(true)
    try {
      const created = await api.tokens.create(app.id, tokenName.trim() || 'MCP client')
      setNewToken(created.token)
      setTokens(ts => [created, ...ts])
      success('Token created', 'Copy it now — it will not be shown again')
    } catch (err) {
      error('Could not create token', apiError(err))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(t: McpToken) {
    if (!confirm(`Revoke "${t.name}"? Clients using it will be disconnected immediately.`)) return
    try {
      await api.tokens.revoke(app.id, t.id)
      setTokens(ts => ts.map(x => (x.id === t.id ? { ...x, revokedAt: Date.now() } : x)))
      success('Token revoked', t.name)
    } catch (err) {
      error('Could not revoke token', apiError(err))
    }
  }

  const code = snippet(client, serverName, mcpUrl, newToken ?? TOKEN_PLACEHOLDER)
  const current = CLIENTS.find(c => c.key === client)!
  const liveGrants = grants.filter(g => !g.revokedAt && g.expiresAt > Date.now())
  const fmt = (ms: number) => new Date(ms).toLocaleDateString()

  return (
    <div className="space-y-5">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-white text-base">Your MCP Server URL</h2>
          <span className="text-[10px] font-medium text-brand-300 bg-brand-950 border border-brand-900 px-1.5 py-0.5 rounded">Streamable HTTP</span>
        </div>
        <p className="text-sm text-gray-500 mt-0.5 mb-4">Clients sign in to MCPHub (OAuth) the first time they connect.</p>
        <div className="flex items-center gap-2 bg-gray-950 border border-gray-700 rounded-xl px-4 py-3">
          <code className="flex-1 text-sm text-brand-300 font-mono break-all">{mcpUrl}</code>
          <CopyButton text={mcpUrl} />
        </div>
        <p className="text-xs text-gray-600 mt-3">
          Older clients that only support the legacy SSE transport can use{' '}
          <code className="text-gray-500 font-mono break-all">{mcpUrl}/sse</code>
        </p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="font-semibold text-white mb-3">Connect a client</h2>
        <div className="flex flex-wrap gap-1.5 mb-3" role="tablist">
          {CLIENTS.map(c => (
            <button
              key={c.key} role="tab" aria-selected={client === c.key} onClick={() => setClient(c.key)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                client === c.key ? 'bg-brand-950 border-brand-800 text-brand-300' : 'border-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-gray-500 mb-3">{current.hint}</p>
        {!current.oauth && !newToken && (
          <p className="text-xs text-amber-400/80 mb-3">
            {active.length ? `Replace ${TOKEN_PLACEHOLDER} with one of your tokens, or create a new one to fill it in.` : 'Create a token below to fill in the command.'}
          </p>
        )}
        <div className="relative">
          <pre className="bg-gray-950 border border-gray-800 rounded-xl p-5 pr-12 text-xs text-gray-300 font-mono overflow-x-auto leading-relaxed whitespace-pre-wrap break-all">{code}</pre>
          <div className="absolute top-3 right-3">
            <CopyButton text={code} />
          </div>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <PlugZap className="w-4 h-4 text-brand-400" />
          <h2 className="font-semibold text-white">Connected clients</h2>
        </div>
        <p className="text-sm text-gray-500 mb-3">Clients you approved through the sign-in flow. Disconnecting revokes their access immediately.</p>
        {liveGrants.length === 0 ? (
          <p className="text-xs text-gray-600">No clients connected yet.</p>
        ) : (
          <ul className="divide-y divide-gray-800 border border-gray-800 rounded-lg">
            {liveGrants.map(g => (
              <li key={g.id} className="flex items-center gap-3 px-3 py-2.5 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="text-white truncate">{g.clientName}</p>
                  <p className="text-gray-600">connected {fmt(g.createdAt)}{g.lastUsedAt ? ` · last refreshed ${fmt(g.lastUsedAt)}` : ''}</p>
                </div>
                <button onClick={() => disconnect(g)} className="text-gray-500 hover:text-red-400 p-1" aria-label={`Disconnect ${g.clientName}`} title="Disconnect">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="w-4 h-4 text-brand-400" />
          <h2 className="font-semibold text-white">Access tokens <span className="text-gray-500 font-normal text-sm">(optional)</span></h2>
        </div>
        <p className="text-sm text-gray-500 mb-4">For scripts and headless clients that can't sign in with OAuth. Tokens expire after 90 days.</p>

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={tokenName} onChange={e => setTokenName(e.target.value)} maxLength={100} placeholder="Token name"
            aria-label="Token name"
            className="flex-1 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <button
            onClick={create} disabled={busy}
            className="flex items-center justify-center gap-1.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-onaccent px-4 py-2 rounded-lg text-sm font-medium"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Create token
          </button>
        </div>

        {newToken && (
          <div className="mt-4 bg-amber-950/40 border border-amber-900 rounded-xl p-4">
            <div className="flex items-center gap-2 text-amber-300 text-xs font-medium mb-2">
              <ShieldAlert className="w-3.5 h-3.5" />
              Copy this token now. It is stored hashed and cannot be shown again.
            </div>
            <div className="flex items-center gap-2 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
              <code className="flex-1 text-xs text-gray-200 font-mono break-all">{newToken}</code>
              <CopyButton text={newToken} />
            </div>
          </div>
        )}

        {tokens.length > 0 && (
          <ul className="mt-4 divide-y divide-gray-800 border border-gray-800 rounded-lg">
            {tokens.map(t => {
              const status = t.revokedAt ? 'revoked' : t.expiresAt <= Date.now() ? 'expired' : 'active'
              return (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2.5 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="text-white truncate">{t.name}</p>
                    <p className="text-gray-600 font-mono">
                      {t.prefix}… · created {fmt(t.createdAt)} · expires {fmt(t.expiresAt)}
                      {t.lastUsedAt ? ` · last used ${fmt(t.lastUsedAt)}` : ' · never used'}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded ${status === 'active' ? 'bg-green-950 text-green-400' : 'bg-gray-800 text-gray-500'}`}>{status}</span>
                  {status === 'active' && (
                    <button onClick={() => revoke(t)} className="text-gray-500 hover:text-red-400 p-1" aria-label={`Revoke ${t.name}`} title="Revoke">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
