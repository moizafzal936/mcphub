import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Zap, Trash2, ExternalLink, Activity, Clock } from 'lucide-react'
import { api, apiError, type App } from '../lib/api.ts'
import { useToast } from '../components/Toast.tsx'
import { CopyButton } from '../components/CopyButton.tsx'

// The Vite dev proxy runs on :3000; MCP clients connect to the API server directly.
function mcpUrlFor(appId: string): string {
  const origin = window.location.port === '3000' ? window.location.origin.replace(':3000', ':3001') : window.location.origin
  return `${origin}/mcp/${appId}`
}

function timeAgo(ts: number | null) {
  if (!ts) return null
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

export default function AppsPage() {
  const [apps, setApps] = useState<(App & { lastUsed?: number | null })[]>([])
  const [loading, setLoading] = useState(true)
  const { success, error } = useToast()

  const [orphans, setOrphans] = useState(0)
  const [claiming, setClaiming] = useState(false)

  function load() {
    api.apps.list().then(setApps).catch(() => error('Failed to load apps')).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    api.orphans.status().then(s => setOrphans(s.canClaim ? s.count : 0)).catch(() => {})
  }, [])

  async function claimOrphans() {
    setClaiming(true)
    try {
      const { claimed } = await api.orphans.claim()
      setOrphans(0)
      success(`Claimed ${claimed} app${claimed === 1 ? '' : 's'}`, 'They now belong to your account')
      load()
    } catch (err) {
      error('Could not claim apps', apiError(err))
    } finally {
      setClaiming(false)
    }
  }

  async function deleteApp(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This removes all tools and logs.`)) return
    try {
      await api.apps.delete(id)
      setApps(apps => apps.filter(a => a.id !== id))
      success('App deleted', name)
    } catch {
      error('Delete failed')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Your Apps</h1>
          <p className="text-sm text-gray-500 mt-1">
            {apps.length > 0
              ? `${apps.length} API${apps.length !== 1 ? 's' : ''} connected · ${apps.reduce((s, a) => s + (a.toolCount ?? 0), 0)} total MCP tools`
              : 'Connect any REST API to generate an MCP server instantly'
            }
          </p>
        </div>
        <Link
          to="/apps/new"
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors shadow-lg shadow-brand-900/30"
        >
          <Plus className="w-4 h-4" />
          Connect API
        </Link>
      </div>

      {orphans > 0 && (
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3 bg-amber-950/30 border border-amber-900 rounded-xl px-4 py-3">
          <p className="flex-1 text-sm text-amber-200">
            {orphans} app{orphans === 1 ? ' was' : 's were'} created before accounts existed and {orphans === 1 ? 'has' : 'have'} no owner.
            As this server's operator, you can claim {orphans === 1 ? 'it' : 'them'}.
          </p>
          <button
            onClick={claimOrphans} disabled={claiming}
            className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap"
          >
            {claiming ? 'Claiming…' : `Claim ${orphans === 1 ? 'app' : 'apps'}`}
          </button>
        </div>
      )}

      {loading && (
        <div className="grid gap-3">
          {[1, 2].map(i => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-5 animate-pulse h-20" />
          ))}
        </div>
      )}

      {!loading && apps.length === 0 && (
        <div className="border border-dashed border-gray-800 rounded-2xl p-16 text-center">
          <div className="w-14 h-14 bg-brand-950 border border-brand-900 rounded-2xl flex items-center justify-center mx-auto mb-5">
            <Zap className="w-7 h-7 text-brand-400" />
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">No APIs connected yet</h2>
          <p className="text-gray-500 text-sm mb-6 max-w-sm mx-auto">
            Add your first REST API to generate a hosted MCP server in under 60 seconds.
          </p>
          <Link
            to="/apps/new"
            className="inline-flex items-center gap-2 bg-brand-600 hover:bg-brand-500 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Connect your first API
          </Link>
        </div>
      )}

      <div className="grid gap-3">
        {apps.map(app => {
          const ago = timeAgo(app.lastUsed ?? null)
          return (
            <div
              key={app.id}
              className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-5 flex items-center gap-4 transition-all group"
            >
              <div className="w-10 h-10 bg-brand-950 border border-brand-900 rounded-xl flex items-center justify-center flex-shrink-0">
                <Zap className="w-4.5 h-4.5 text-brand-400" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h3 className="font-semibold text-white">{app.name}</h3>
                  <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full whitespace-nowrap">
                    {app.toolCount ?? 0} tools
                  </span>
                  <span className="flex items-center gap-1 text-xs text-green-400 bg-green-950/50 border border-green-900/50 px-2 py-0.5 rounded-full">
                    <span className="w-1 h-1 rounded-full bg-green-400" />
                    Live
                  </span>
                  {app.readOnly && (
                    <span className="text-xs text-amber-300 bg-amber-950 border border-amber-900 px-2 py-0.5 rounded-full whitespace-nowrap">Read-only</span>
                  )}
                </div>
                <p className="text-xs text-gray-600 truncate mt-0.5 font-mono">{app.baseUrl}</p>
                <div className="flex items-center gap-1.5 mt-1 text-[11px] text-gray-500" onClick={e => e.preventDefault()}>
                  <span className="truncate font-mono">MCP: {mcpUrlFor(app.id)}</span>
                  <CopyButton text={mcpUrlFor(app.id)} />
                </div>
                {ago && (
                  <p className="text-xs text-gray-700 mt-0.5 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Last call {ago}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <Link
                  to={`/apps/${app.id}?tab=test`}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 px-3 py-1.5 rounded-lg transition-colors"
                  title="Test tools"
                >
                  <Activity className="w-3.5 h-3.5" />
                  Test
                </Link>
                <Link
                  to={`/apps/${app.id}`}
                  className="flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300 border border-brand-900 hover:border-brand-700 px-3 py-1.5 rounded-lg transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Manage
                </Link>
                <button
                  onClick={() => deleteApp(app.id, app.name)}
                  className="text-gray-700 hover:text-red-400 transition-colors p-1.5 rounded-lg hover:bg-red-950/50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Always-visible manage on mobile */}
              <Link
                to={`/apps/${app.id}`}
                className="md:hidden flex items-center gap-1.5 text-xs text-brand-400 border border-brand-900 px-3 py-1.5 rounded-lg"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}
