import { useState } from 'react'
import { Play, Loader2, CheckCircle, XCircle, Search, ChevronRight, Scissors } from 'lucide-react'
import { api, apiError, type ExecResult, type McpTool } from '../lib/api.ts'
import { useToast } from './Toast.tsx'
import { ResponseShapeModal } from './ResponseShapeModal.tsx'

interface ToolTesterProps {
  appId: string
  tools: McpTool[]
  onToolUpdated?: (tool: McpTool) => void
}

function methodColor(method: string) {
  const colors: Record<string, string> = {
    GET: 'bg-blue-950 text-blue-400 border-blue-900',
    POST: 'bg-green-950 text-green-400 border-green-900',
    PUT: 'bg-yellow-950 text-yellow-400 border-yellow-900',
    PATCH: 'bg-orange-950 text-orange-400 border-orange-900',
    DELETE: 'bg-red-950 text-red-400 border-red-900',
  }
  return colors[method] ?? 'bg-gray-800 text-gray-400 border-gray-700'
}

export function ToolTester({ appId, tools, onToolUpdated }: ToolTesterProps) {
  const { success, error } = useToast()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<McpTool | null>(tools[0] ?? null)
  const [args, setArgs] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ExecResult | null>(null)
  const [view, setView] = useState<'ai' | 'full'>('full')
  const [shaping, setShaping] = useState(false)
  const canShape = !!result && result.statusCode >= 200 && result.statusCode < 300 && !!result.data && typeof result.data === 'object'

  const filtered = tools.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.path.toLowerCase().includes(search.toLowerCase()) ||
    t.description.toLowerCase().includes(search.toLowerCase())
  )

  function selectTool(tool: McpTool) {
    setSelected(tool)
    setArgs({})
    setResult(null)
  }

  async function execute() {
    if (!selected) return
    setRunning(true)
    setResult(null)
    try {
      const res = await api.tools.execute(appId, selected.id, args)
      setResult(res)
      setView(res.shaped ? 'ai' : 'full')
      if (res.statusCode === 0) {
        error('Tool call failed', res.error ?? 'Request was not sent')
      } else if (res.statusCode < 400) {
        success('Tool executed', `${res.statusCode} · ${res.durationMs}ms`)
      } else {
        error('Tool returned error', `HTTP ${res.statusCode}`)
      }
    } catch (err: any) {
      error('Execution failed', apiError(err))
    } finally {
      setRunning(false)
    }
  }

  const allParams = selected
    ? [
        ...selected.parameters,
        ...(selected.requestBodySchema
          ? Object.entries((selected.requestBodySchema as any).properties ?? {}).map(
              ([name, schema]: [string, any]) => ({
                name,
                in: 'body',
                description: schema.description ?? name,
                required: ((selected.requestBodySchema as any).required ?? []).includes(name),
                schema: { type: schema.type ?? 'string' },
              })
            )
          : []),
      ]
    : []

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0 gap-0 border border-gray-800 rounded-xl overflow-hidden">
      {/* Tool list (stacked above the runner on narrow screens) */}
      <div className="md:w-64 max-h-48 md:max-h-none flex-shrink-0 border-b md:border-b-0 md:border-r border-gray-800 flex flex-col bg-gray-950">
        <div className="p-3 border-b border-gray-800">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input
              type="text"
              placeholder="Search tools..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map(tool => (
            <button
              key={tool.id}
              onClick={() => selectTool(tool)}
              className={`w-full text-left px-3 py-2.5 border-b border-gray-900 transition-colors flex items-center gap-2 group ${
                selected?.id === tool.id
                  ? 'bg-brand-950 border-l-2 border-l-brand-500'
                  : 'hover:bg-gray-900'
              }`}
            >
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 ${methodColor(tool.method)}`}>
                {tool.method.slice(0, 3)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-white truncate">{tool.name}</p>
                <p className="text-[10px] text-gray-600 truncate font-mono">{tool.path}</p>
              </div>
              <ChevronRight className={`w-3 h-3 flex-shrink-0 transition-opacity ${selected?.id === tool.id ? 'opacity-100 text-brand-400' : 'opacity-0 group-hover:opacity-50 text-gray-500'}`} />
            </button>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select a tool to test
          </div>
        ) : (
          <>
            {/* Tool header */}
            <div className="px-5 py-4 border-b border-gray-800 bg-gray-950 flex-shrink-0">
              <div className="flex items-center gap-3">
                <span className={`text-xs font-bold px-2 py-1 rounded border ${methodColor(selected.method)}`}>
                  {selected.method}
                </span>
                <code className="text-sm text-gray-300 font-mono break-all">{selected.path}</code>
              </div>
              <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{selected.description}</p>
            </div>

            {/* Params */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3 min-h-0">
              {allParams.length === 0 ? (
                <p className="text-xs text-gray-600 italic">No parameters required — just click Execute</p>
              ) : (
                allParams.map(param => (
                  <div key={param.name}>
                    <label className="flex items-center gap-2 text-xs font-medium text-gray-400 mb-1">
                      {param.name}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        param.in === 'path' ? 'bg-purple-950 text-purple-400' :
                        param.in === 'query' ? 'bg-blue-950 text-blue-400' :
                        param.in === 'body' ? 'bg-green-950 text-green-400' :
                        'bg-gray-800 text-gray-500'
                      }`}>
                        {param.in}
                      </span>
                      {param.required && <span className="text-red-400">*</span>}
                    </label>
                    <input
                      type="text"
                      placeholder={param.description || param.name}
                      value={args[param.name] ?? ''}
                      onChange={e => setArgs(a => ({ ...a, [param.name]: e.target.value }))}
                      className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                    />
                  </div>
                ))
              )}
            </div>

            {/* Execute button — always visible */}
            <div className="flex-shrink-0 p-4 border-t border-gray-800">
              <button
                onClick={execute}
                disabled={running}
                className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-onaccent py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                {running
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Running...</>
                  : <><Play className="w-4 h-4" /> Execute Tool</>
                }
              </button>
            </div>

            {/* Result — always visible, fixed height at bottom */}
            {result && (
              <div className="flex-shrink-0 border-t-2 border-gray-700 bg-gray-950 flex flex-col max-h-64">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2.5 border-b border-gray-800 flex-shrink-0">
                  {result.statusCode > 0 && result.statusCode < 400
                    ? <CheckCircle className="w-4 h-4 text-green-400" />
                    : <XCircle className="w-4 h-4 text-red-400" />
                  }
                  <span className={`text-xs font-bold px-2 py-0.5 rounded ${result.statusCode > 0 && result.statusCode < 400 ? 'bg-green-950 text-green-400' : 'bg-red-950 text-red-400'}`}>
                    {result.statusCode || 'ERR'}
                  </span>
                  <span className="text-xs text-gray-500">{result.durationMs}ms</span>
                  <div className="ml-auto flex items-center gap-2">
                    <div className="flex rounded-md border border-gray-800 overflow-hidden text-[11px]" role="group" aria-label="Response view">
                      {(['ai', 'full'] as const).map(v => (
                        <button key={v} onClick={() => setView(v)} aria-pressed={view === v}
                          className={`px-2 py-0.5 whitespace-nowrap ${view === v ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                          {v === 'ai' ? 'AI sees' : 'Full response'}
                        </button>
                      ))}
                    </div>
                    {canShape && (
                      <button onClick={() => setShaping(true)} className="flex items-center gap-1 text-[11px] text-brand-400 hover:text-brand-300 whitespace-nowrap"
                        title="Choose which fields AI clients receive">
                        <Scissors className="w-3 h-3" />
                        {selected.responseFields?.length ? `${selected.responseFields.length} fields` : 'Fields for AI'}
                      </button>
                    )}
                  </div>
                </div>
                {(result.statusCode === 401 || result.statusCode === 403) && (
                  <div className="px-5 py-2 border-b border-gray-800 flex-shrink-0 text-xs text-amber-300 bg-amber-950/30">
                    The API rejected the stored credential. Check or replace the API key in this app's Settings tab.
                  </div>
                )}
                {result.request && (
                  <div className="px-5 py-2 border-b border-gray-800 flex-shrink-0 text-[11px] font-mono text-gray-500 break-all" title="Sent upstream (credential header not shown)">
                    <span className="text-gray-400">{result.request.method}</span> {result.request.url}
                  </div>
                )}
                {view === 'ai' && result.shaped && (
                  <div className="px-5 py-1.5 border-b border-gray-800 flex-shrink-0 text-[11px] text-green-400">
                    Shaped to the chosen fields: {result.text.length.toLocaleString()} of {JSON.stringify(result.data, null, 2).length.toLocaleString()} characters
                  </div>
                )}
                <pre className="flex-1 overflow-auto p-4 text-xs text-gray-300 font-mono leading-relaxed">
                  {view === 'ai' ? result.text : JSON.stringify(result.data, null, 2)}
                </pre>
              </div>
            )}
            {shaping && result && (
              <ResponseShapeModal
                appId={appId} tool={selected} sample={result.data} onClose={() => setShaping(false)}
                onSaved={responseFields => {
                  const updated = { ...selected, responseFields }
                  setSelected(updated)
                  onToolUpdated?.(updated)
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
