import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Zap, ToggleLeft, ToggleRight,
  Clock, CheckCircle, XCircle, Activity, Terminal, List, Radio,
  Plus, Trash2, X, Settings, Sparkles, TerminalSquare, FileUp, Pencil
} from 'lucide-react'
import { api, apiError, type App, type McpTool, type ToolCallLog } from '../lib/api.ts'
import { useToast } from '../components/Toast.tsx'
import { ToolTester } from '../components/ToolTester.tsx'
import { ConnectPanel } from '../components/ConnectPanel.tsx'
import { SettingsPanel } from '../components/SettingsPanel.tsx'
import { PlaygroundPanel } from '../components/PlaygroundPanel.tsx'
import { CurlImportModal } from '../components/CurlImportModal.tsx'
import { ImportSpecModal } from '../components/ImportSpecModal.tsx'

type Tab = 'connect' | 'tools' | 'test' | 'playground' | 'logs' | 'settings'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

function ActivityChart({ logs }: { logs: ToolCallLog[] }) {
  const hours = 24
  const now = Date.now()
  const buckets = Array.from({ length: hours }, (_, i) => {
    const start = now - (hours - i) * 3600000
    const end = start + 3600000
    return logs.filter(l => l.calledAt >= start && l.calledAt < end).length
  })
  const max = Math.max(...buckets, 1)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-white text-sm">Activity (24h)</h2>
        <span className="text-xs text-gray-500">{logs.length} total calls</span>
      </div>
      <div className="flex items-end gap-0.5 h-16">
        {buckets.map((count, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm transition-all"
            style={{
              height: `${Math.max((count / max) * 100, count > 0 ? 8 : 2)}%`,
              backgroundColor: count > 0 ? `rgba(99, 102, 241, ${0.3 + (count / max) * 0.7})` : 'rgba(55, 65, 81, 0.5)',
            }}
            title={`${count} calls`}
          />
        ))}
      </div>
      <div className="flex justify-between mt-2 text-[10px] text-gray-700">
        <span>24h ago</span>
        <span>now</span>
      </div>
    </div>
  )
}

interface ParamRow {
  name: string
  description: string
  required: boolean
  in: 'query' | 'header' | 'body'
  type: 'string' | 'number' | 'integer' | 'boolean'
}

function AddToolModal({ appId, onClose, onAdded }: {
  appId: string
  onClose: () => void
  onAdded: (tool: McpTool) => void
}) {
  const { success, error } = useToast()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', method: 'GET', path: '/' })
  const [queryParams, setQueryParams] = useState<ParamRow[]>([])
  const defaultIn: ParamRow['in'] = form.method === 'GET' || form.method === 'DELETE' ? 'query' : 'body'

  function set(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  function addQueryParam() {
    setQueryParams(p => [...p, { name: '', description: '', required: false, in: defaultIn, type: 'string' }])
  }

  function updateQueryParam(i: number, field: string, value: string | boolean) {
    setQueryParams(p => p.map((param, idx) => idx === i ? { ...param, [field]: value } : param))
  }

  function removeQueryParam(i: number) {
    setQueryParams(p => p.filter((_, idx) => idx !== i))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const validQueryParams = queryParams.filter(p => p.name.trim()).map(p => ({
        name: p.name.trim(),
        in: p.in,
        type: p.type,
        description: p.description || p.name.trim(),
        required: p.required,
      }))
      const tool = await api.tools.create(appId, { ...form, queryParams: validQueryParams })
      success('Tool created', form.name)
      onAdded(tool)
      onClose()
    } catch (err: any) {
      error('Failed to create tool', apiError(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl my-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white">Add Tool Manually</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Tool Name <span className="text-brand-400">*</span>
            </label>
            <input
              type="text"
              placeholder="get_user_by_id"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              required
              className="input"
            />
            <p className="text-xs text-gray-600 mt-1">Use snake_case — this is what Claude calls</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Description
            </label>
            <input
              type="text"
              placeholder="Fetch a user by their ID"
              value={form.description}
              onChange={e => set('description', e.target.value)}
              className="input"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                Method
              </label>
              <select
                value={form.method}
                onChange={e => set('method', e.target.value)}
                className="input"
              >
                {HTTP_METHODS.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                Path <span className="text-brand-400">*</span>
              </label>
              <input
                type="text"
                placeholder="/users/{id}"
                value={form.path}
                onChange={e => set('path', e.target.value)}
                required
                className="input font-mono"
              />
            </div>
          </div>
          <p className="text-[10px] text-gray-600">
            Use <code className="text-gray-500">{'{id}'}</code> for path params — they're auto-detected
          </p>

          {/* Parameters */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Parameters
              </label>
              <button
                type="button"
                onClick={addQueryParam}
                className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
            {queryParams.length === 0 && (
              <p className="text-xs text-gray-700 italic">
                Query (?status=available), header, or JSON body fields (POST/PUT/PATCH) — click Add above
              </p>
            )}
            <div className="space-y-3">
              {queryParams.map((param, i) => (
                <div key={i} className="space-y-1.5 border border-gray-800 rounded-lg p-2">
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      placeholder="name"
                      aria-label="Parameter name"
                      value={param.name}
                      onChange={e => updateQueryParam(i, 'name', e.target.value)}
                      className="flex-1 min-w-0 bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-700 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                    />
                    <select
                      aria-label="Parameter location"
                      value={param.in}
                      onChange={e => updateQueryParam(i, 'in', e.target.value)}
                      className="bg-gray-950 border border-gray-800 rounded-lg px-1.5 py-1.5 text-xs text-gray-300"
                    >
                      <option value="query">query</option>
                      <option value="header">header</option>
                      <option value="body" disabled={form.method === 'GET'}>body</option>
                    </select>
                    <select
                      aria-label="Parameter type"
                      value={param.type}
                      onChange={e => updateQueryParam(i, 'type', e.target.value)}
                      className="bg-gray-950 border border-gray-800 rounded-lg px-1.5 py-1.5 text-xs text-gray-300"
                    >
                      <option value="string">string</option>
                      <option value="number">number</option>
                      <option value="integer">integer</option>
                      <option value="boolean">boolean</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeQueryParam(i)}
                      aria-label="Remove parameter"
                      className="text-gray-600 hover:text-red-400 flex-shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      placeholder="description (helps the AI use it correctly)"
                      aria-label="Parameter description"
                      value={param.description}
                      onChange={e => updateQueryParam(i, 'description', e.target.value)}
                      className="flex-1 min-w-0 bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-700 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                    <label className="flex items-center gap-1 text-[11px] text-gray-500 flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={param.required}
                        onChange={e => updateQueryParam(i, 'required', e.target.checked)}
                      />
                      required
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 border border-gray-800 rounded-xl text-sm text-gray-400 hover:text-white transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white py-2.5 rounded-xl text-sm font-medium transition-colors"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add Tool
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function methodColor(method: string) {
  const colors: Record<string, string> = {
    GET: 'bg-blue-950 text-blue-400',
    POST: 'bg-green-950 text-green-400',
    PUT: 'bg-yellow-950 text-yellow-400',
    PATCH: 'bg-orange-950 text-orange-400',
    DELETE: 'bg-red-950 text-red-400',
  }
  return colors[method] ?? 'bg-gray-800 text-gray-400'
}

export default function AppDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { success, error, info } = useToast()
  const [app, setApp] = useState<App | null>(null)
  const [tools, setTools] = useState<McpTool[]>([])
  const [logs, setLogs] = useState<ToolCallLog[]>([])
  const [tab, setTab] = useState<Tab>('connect')
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [liveLogs, setLiveLogs] = useState(false)
  const [showAddTool, setShowAddTool] = useState(false)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [showCurl, setShowCurl] = useState(false)
  const [showSpec, setShowSpec] = useState(false)
  const [editing, setEditing] = useState<{ id: string; name: string; description: string } | null>(null)
  const logPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchLogs = useCallback(async () => {
    if (!id) return
    const fresh = await api.logs.list(id)
    setLogs(prev => {
      if (JSON.stringify(fresh.map(l => l.id)) !== JSON.stringify(prev.map(l => l.id))) {
        return fresh
      }
      return prev
    })
  }, [id])

  useEffect(() => {
    if (!id) return
    Promise.all([api.apps.get(id), api.tools.list(id), api.logs.list(id)])
      .then(([app, tools, logs]) => {
        setApp(app)
        setTools(tools)
        setLogs(logs)
      })
      .catch(() => error('Failed to load app'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    if (liveLogs) {
      logPollRef.current = setInterval(fetchLogs, 2000)
    } else {
      if (logPollRef.current) clearInterval(logPollRef.current)
    }
    return () => { if (logPollRef.current) clearInterval(logPollRef.current) }
  }, [liveLogs, fetchLogs])

  // Auto-enable live logs when on logs tab
  useEffect(() => {
    if (tab === 'logs') setLiveLogs(true)
    else setLiveLogs(false)
  }, [tab])

  async function reimport() {
    if (!app) return
    setImporting(true)
    try {
      const result = await api.apps.import(app.id)
      setTools(result.tools ?? [])
      success(`Imported ${result.imported} tools`)
      setTab('tools')
    } catch (err: any) {
      error('Import failed', apiError(err))
    } finally {
      setImporting(false)
    }
  }

  async function toggleTool(tool: McpTool) {
    await api.tools.toggle(app!.id, tool.id, !tool.enabled)
    setTools(ts => ts.map(t => t.id === tool.id ? { ...t, enabled: !t.enabled } : t))
    info(tool.enabled ? 'Tool disabled' : 'Tool enabled', tool.name)
  }

  async function saveEdit() {
    if (!editing || !app) return
    try {
      await api.tools.updateMeta(app.id, editing.id, { name: editing.name.trim(), description: editing.description })
      setTools(ts => ts.map(t => (t.id === editing.id ? { ...t, name: editing.name.trim(), description: editing.description } : t)))
      success('Tool updated', editing.name.trim())
      setEditing(null)
    } catch (err) {
      error('Could not update tool', apiError(err))
    }
  }

  async function deleteTool(tool: McpTool) {
    await api.tools.delete(app!.id, tool.id)
    setTools(ts => ts.filter(t => t.id !== tool.id))
    info('Tool deleted', tool.name)
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <RefreshCw className="w-5 h-5 text-gray-600 animate-spin" />
    </div>
  )
  if (!app) return <div className="text-red-400 p-8">App not found</div>

  // Vite dev proxy (port 3000) forwards /mcp to the actual server (3001).
  // Claude Desktop connects directly — it needs the server URL, not the proxy.
  const isDev = window.location.port === '3000'
  const serverOrigin = isDev
    ? window.location.origin.replace(':3000', ':3001')
    : window.location.origin
  const mcpUrl = `${serverOrigin}/mcp/${id}`
  const enabledCount = tools.filter(t => t.enabled).length
  const todayLogs = logs.filter(l => l.calledAt > Date.now() - 86400000)

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/dashboard')} className="text-gray-500 hover:text-white transition-colors p-1">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="w-9 h-9 bg-brand-950 border border-brand-900 rounded-xl flex items-center justify-center">
          <Zap className="w-4 h-4 text-brand-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white leading-tight flex items-center gap-2">
            {app.name}
            {app.readOnly && <span className="text-[10px] font-medium text-amber-300 bg-amber-950 border border-amber-900 px-1.5 py-0.5 rounded">Read-only</span>}
          </h1>
          <p className="text-xs text-gray-500 font-mono">{app.baseUrl}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {app.specUrl && (
            <button
              onClick={reimport}
              disabled={importing}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white border border-gray-800 hover:border-gray-700 px-3 py-1.5 rounded-lg transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${importing ? 'animate-spin' : ''}`} />
              Re-import
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <Stat label="Total Tools" value={tools.length} icon={<List className="w-4 h-4 text-brand-400" />} />
        <Stat label="Enabled" value={enabledCount} icon={<CheckCircle className="w-4 h-4 text-green-400" />} />
        <Stat label="Calls Today" value={todayLogs.length} icon={<Activity className="w-4 h-4 text-purple-400" />} />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800 mb-5 gap-0">
        {([
          { key: 'connect', label: 'Connect', icon: Zap },
          { key: 'tools', label: `Tools (${tools.length})`, icon: List },
          { key: 'test', label: 'Test', icon: Terminal },
          { key: 'playground', label: 'Playground', icon: Sparkles },
          { key: 'logs', label: 'Live Logs', icon: Radio },
          { key: 'settings', label: 'Settings', icon: Settings },
        ] as { key: Tab; label: string; icon: any }[]).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${
              tab === t.key
                ? 'border-brand-400 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
            {t.key === 'logs' && liveLogs && (
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse ml-1" />
            )}
          </button>
        ))}
      </div>

      {/* Connect tab */}
      {tab === 'connect' && (
        <div className="space-y-5">
          <ConnectPanel app={app} mcpUrl={mcpUrl} />
          <ActivityChart logs={logs} />
        </div>
      )}

      {showSpec && <ImportSpecModal app={{ ...app, toolCount: tools.length }} onClose={() => setShowSpec(false)} onImported={ts => { setTools(ts); setTab('tools') }} />}
      {showCurl && <CurlImportModal app={app} onClose={() => setShowCurl(false)} onAdded={tool => setTools(ts => [...ts, tool])} />}
      {tab === 'settings' && <SettingsPanel app={app} onUpdated={setApp} />}
      {tab === 'playground' && <PlaygroundPanel app={app} />}

      {/* Tools tab */}
      {tab === 'tools' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-600">{tools.length} tools</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSpec(true)}
                className="flex items-center gap-1.5 text-xs border border-gray-700 hover:border-gray-600 text-gray-300 px-3 py-1.5 rounded-lg transition-colors"
              >
                <FileUp className="w-3.5 h-3.5" />
                Import spec
              </button>
              <button
                onClick={() => setShowCurl(true)}
                className="flex items-center gap-1.5 text-xs border border-gray-700 hover:border-gray-600 text-gray-300 px-3 py-1.5 rounded-lg transition-colors"
              >
                <TerminalSquare className="w-3.5 h-3.5" />
                From curl
              </button>
              <button
                onClick={() => setShowAddTool(true)}
                className="flex items-center gap-1.5 text-xs bg-brand-950 hover:bg-brand-900 border border-brand-800 text-brand-300 px-3 py-1.5 rounded-lg transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Tool
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            {tools.length === 0 && (
              <div className="text-center py-16 text-gray-600">
                <p className="mb-2">No tools yet.</p>
                <p className="text-xs mb-4">Add tools manually or import from an OpenAPI spec.</p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={() => setShowAddTool(true)}
                    className="flex items-center gap-1.5 text-brand-400 hover:text-brand-300 text-sm"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add first tool
                  </button>
                  {app.specUrl && (
                    <>
                      <span className="text-gray-800">·</span>
                      <button onClick={reimport} className="text-brand-400 hover:text-brand-300 text-sm">
                        Import from spec →
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            {tools.map(tool => (
              <div
                key={tool.id}
                className={`bg-gray-900 border rounded-xl px-4 py-3.5 flex items-center gap-3 transition-all group ${
                  tool.enabled ? 'border-gray-800 hover:border-gray-700' : 'border-gray-900 opacity-40'
                }`}
              >
                <span className={`text-xs font-mono px-2 py-0.5 rounded-md font-bold flex-shrink-0 ${methodColor(tool.method)}`}>
                  {tool.method}
                </span>
                {editing?.id === tool.id ? (
                  <form className="flex-1 min-w-0 space-y-2" onSubmit={e => { e.preventDefault(); saveEdit() }}>
                    <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} aria-label="Tool name"
                      className="w-full bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-white font-mono focus:outline-none focus:ring-1 focus:ring-brand-500" />
                    <textarea value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} rows={3} maxLength={2000}
                      aria-label="Tool description" placeholder="Explain when an AI should use this tool and what it returns"
                      className="w-full bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-brand-500" />
                    <div className="flex gap-2">
                      <button type="submit" className="text-xs bg-brand-600 hover:bg-brand-500 text-white px-3 py-1 rounded-lg">Save</button>
                      <button type="button" onClick={() => setEditing(null)} className="text-xs text-gray-400 hover:text-white px-3 py-1">Cancel</button>
                    </div>
                  </form>
                ) : (
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white">{tool.name}</p>
                    <p className="text-xs text-gray-500 truncate">{tool.description}</p>
                  </div>
                )}
                <code className="text-xs text-gray-700 font-mono hidden md:block flex-shrink-0">{tool.path}</code>
                <button
                  onClick={() => setEditing({ id: tool.id, name: tool.name, description: tool.description })}
                  className="text-gray-600 hover:text-white transition-colors flex-shrink-0"
                  title="Edit name and description" aria-label={`Edit ${tool.name}`}
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => toggleTool(tool)}
                  className="text-gray-500 hover:text-white transition-colors flex-shrink-0"
                  title={tool.enabled ? 'Disable tool' : 'Enable tool'}
                >
                  {tool.enabled
                    ? <ToggleRight className="w-5 h-5 text-brand-400" />
                    : <ToggleLeft className="w-5 h-5" />
                  }
                </button>
                <button
                  onClick={() => deleteTool(tool)}
                  className="text-gray-700 hover:text-red-400 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                  title="Delete tool"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Test tab */}
      {tab === 'test' && (
        <div style={{ height: 'calc(100vh - 320px)', minHeight: '380px' }}>
          {tools.filter(t => t.enabled).length === 0 ? (
            <div className="text-center py-16 text-gray-600">
              No enabled tools to test. Enable some tools first.
            </div>
          ) : (
            <ToolTester appId={app.id} tools={tools.filter(t => t.enabled)} />
          )}
        </div>
      )}

      {showAddTool && (
        <AddToolModal
          appId={app.id}
          onClose={() => setShowAddTool(false)}
          onAdded={tool => setTools(ts => [...ts, tool])}
        />
      )}

      {/* Logs tab */}
      {tab === 'logs' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <p className="text-xs text-gray-500">
                {logs.length} calls · auto-refreshing every 2s
              </p>
              <label className="flex items-center gap-1 text-xs text-gray-500">
                <input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} />
                errors only
              </label>
            </div>
            <button
              onClick={fetchLogs}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Refresh
            </button>
          </div>

          {logs.length === 0 ? (
            <div className="text-center py-16 text-gray-600 text-sm">
              No calls yet. Connect Claude to start seeing live activity.
            </div>
          ) : (
            <div className="space-y-2">
              {logs.filter(l => !errorsOnly || !isOk(l.statusCode)).map(log => (
                <div key={log.id} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3.5">
                  <div className="flex items-center gap-3 mb-2">
                    {isOk(log.statusCode)
                      ? <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                      : <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    }
                    <span className="text-sm font-semibold text-white font-mono">{log.toolName}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      isOk(log.statusCode) ? 'bg-green-950 text-green-400' : 'bg-red-950 text-red-400'
                    }`}>
                      {log.statusCode || 'ERR'}
                    </span>
                    <span className="text-xs text-gray-600 ml-auto flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {log.durationMs}ms
                    </span>
                    <span className="text-xs text-gray-700">
                      {new Date(log.calledAt).toLocaleTimeString()}
                    </span>
                  </div>
                  {log.statusCode === 0 && typeof (log.output as any)?.error === 'string' && (
                    <p className="text-xs text-red-400/90 mb-2">{(log.output as any).error}</p>
                  )}
                  <details className="text-xs text-gray-600">
                    <summary className="cursor-pointer hover:text-gray-400 transition-colors select-none">
                      View input / output
                    </summary>
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <p className="text-gray-500 mb-1 font-medium">Input</p>
                        <pre className="bg-gray-950 border border-gray-800 rounded-lg p-2.5 overflow-auto max-h-64 text-gray-400 leading-relaxed">
                          {JSON.stringify(log.input, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <p className="text-gray-500 mb-1 font-medium">Output</p>
                        <pre className="bg-gray-950 border border-gray-800 rounded-lg p-2.5 overflow-auto max-h-64 text-gray-400 leading-relaxed">
                          {JSON.stringify(log.output, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </details>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function isOk(status: number): boolean {
  return status > 0 && status < 400
}

function Stat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-3">
      <div className="w-8 h-8 bg-gray-800 rounded-lg flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <div>
        <p className="text-xl font-bold text-white">{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  )
}
