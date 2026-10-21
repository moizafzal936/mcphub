import { useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Loader2, Zap, ChevronDown, ChevronUp, Upload } from 'lucide-react'
import { api, apiError } from '../lib/api.ts'
import { useToast } from '../components/Toast.tsx'

type PresetTool = {
  name: string
  description: string
  method: string
  path: string
  queryParams?: { name: string; description: string; required: boolean; in?: 'query' | 'header' | 'body'; type?: string }[]
}

// Presets without a spec ship curated tools so every demo app works immediately.
const PRESETS: { name: string; baseUrl: string; specUrl: string; icon: string; desc: string; tools?: PresetTool[] }[] = [
  {
    name: 'Petstore (Demo)',
    baseUrl: 'https://petstore3.swagger.io/api/v3',
    specUrl: 'https://petstore3.swagger.io/api/v3/openapi.json',
    icon: '🐾',
    desc: '19 tools from its OpenAPI spec',
  },
  {
    name: 'Weather (Open-Meteo)',
    baseUrl: 'https://api.open-meteo.com/v1',
    specUrl: '',
    icon: '🌦️',
    desc: 'Live weather for any place, no key needed',
    tools: [{
      name: 'get_forecast',
      description: 'Current weather and daily forecast for a latitude/longitude. Use current="temperature_2m,wind_speed_10m" and daily="temperature_2m_max,temperature_2m_min"; timezone="auto".',
      method: 'GET',
      path: '/forecast',
      queryParams: [
        { name: 'latitude', description: 'Latitude, e.g. 31.52', required: true, type: 'number' },
        { name: 'longitude', description: 'Longitude, e.g. 74.35', required: true, type: 'number' },
        { name: 'current', description: 'Comma-separated current variables, e.g. temperature_2m,wind_speed_10m', required: false },
        { name: 'daily', description: 'Comma-separated daily variables, e.g. temperature_2m_max,temperature_2m_min', required: false },
        { name: 'timezone', description: 'Use "auto" for local time', required: false },
        { name: 'forecast_days', description: 'Number of days (1-16)', required: false, type: 'integer' },
      ],
    }],
  },
  {
    name: 'Hacker News',
    baseUrl: 'https://hacker-news.firebaseio.com/v0',
    specUrl: '',
    icon: '📰',
    desc: 'Top stories and comments',
    tools: [
      { name: 'top_stories', description: 'IDs of the current top Hacker News stories, best first. Fetch details with get_item.', method: 'GET', path: '/topstories.json' },
      { name: 'get_item', description: 'A Hacker News story, comment or poll by numeric ID: title, url, score, author and child comment IDs.', method: 'GET', path: '/item/{id}.json' },
    ],
  },
  {
    name: 'Open Library',
    baseUrl: 'https://openlibrary.org',
    specUrl: '',
    icon: '📚',
    desc: 'Search millions of books',
    tools: [{
      name: 'search_books',
      description: 'Search books by title, author or keyword. Returns titles, authors and first publish year.',
      method: 'GET',
      path: '/search.json',
      queryParams: [
        { name: 'q', description: 'Search text, e.g. "dune herbert"', required: true },
        { name: 'limit', description: 'Max results (keep small, e.g. 5)', required: false, type: 'integer' },
        { name: 'fields', description: 'Comma-separated fields, e.g. title,author_name,first_publish_year', required: false },
      ],
    }],
  },
  {
    name: 'JSONPlaceholder',
    baseUrl: 'https://jsonplaceholder.typicode.com',
    specUrl: '',
    icon: '📋',
    desc: 'Fake blog API with reads and writes',
    tools: [
      { name: 'list_posts', description: 'List blog posts, optionally only those by one user.', method: 'GET', path: '/posts',
        queryParams: [{ name: 'userId', description: 'Only posts by this user ID', required: false, type: 'integer' }] },
      { name: 'get_post', description: 'One blog post by ID.', method: 'GET', path: '/posts/{id}' },
      { name: 'create_post', description: 'Create a blog post (the API fakes the write and echoes it back).', method: 'POST', path: '/posts',
        queryParams: [
          { name: 'title', description: 'Post title', required: true, in: 'body' },
          { name: 'body', description: 'Post text', required: true, in: 'body' },
          { name: 'userId', description: 'Author user ID', required: true, in: 'body', type: 'integer' },
        ] },
    ],
  },
  {
    name: 'Custom API',
    baseUrl: '',
    specUrl: '',
    icon: '⚡',
    desc: 'Connect your own REST API',
  },
]

export default function NewAppPage() {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [loading, setLoading] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null)
  const [form, setForm] = useState({
    name: '',
    baseUrl: '',
    specUrl: '',
    apiKey: '',
    apiKeyHeader: 'Authorization',
    apiKeyIn: 'header' as 'header' | 'query',
  })

  const fileRef = useRef<HTMLInputElement>(null)
  const [importingFile, setImportingFile] = useState(false)

  async function importFile(file: File | undefined) {
    if (!file) return
    setImportingFile(true)
    setErrMsg('')
    try {
      const app = await api.apps.importConfig(await file.text())
      const skipped = app.skipped.length ? ` · ${app.skipped.length} unsafe parameter${app.skipped.length === 1 ? '' : 's'} skipped` : ''
      const count = app.toolCount ?? 0
      success(`${count} tool${count === 1 ? '' : 's'} imported`, `${app.name} is live. Add its API key in Settings if it needs one${skipped}`)
      navigate(`/apps/${app.id}`)
    } catch (err) {
      error('Could not import this file', apiError(err).replace(/^Import failed: /, ''))
    } finally {
      setImportingFile(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function set(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  function applyPreset(idx: number) {
    const p = PRESETS[idx]
    setSelectedPreset(idx)
    setForm(f => ({
      ...f,
      name: p.name === 'Custom API' ? '' : p.name,
      baseUrl: p.baseUrl,
      specUrl: p.specUrl,
    }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErrMsg('')
    setLoading(true)
    try {
      const app = await api.apps.create({
        name: form.name,
        baseUrl: form.baseUrl,
        specUrl: form.specUrl || undefined,
        apiKey: form.apiKey || undefined,
        apiKeyHeader: form.apiKeyHeader || (form.apiKeyIn === 'query' ? 'api_key' : 'Authorization'),
        apiKeyIn: form.apiKeyIn,
      })
      let toolCount = app.toolCount ?? 0
      const preset = selectedPreset !== null ? PRESETS[selectedPreset] : undefined
      if (preset?.tools && preset.baseUrl === form.baseUrl.trim().replace(/\/+$/, '')) {
        for (const t of preset.tools) {
          await api.tools.create(app.id, { ...t, queryParams: t.queryParams ?? [] })
          toolCount++
        }
      }
      if (app.warning) {
        success('App created', app.warning)
      } else {
        success(`${toolCount} tools ready`, `${app.name} is live`)
      }
      navigate(`/apps/${app.id}`)
    } catch (err: any) {
      setErrMsg(apiError(err))
      error('Failed to create app')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/dashboard" className="text-gray-500 hover:text-white transition-colors p-1">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-white">Connect an API</h1>
          <p className="text-sm text-gray-500">Get a hosted MCP server in seconds</p>
        </div>
      </div>

      {/* Presets */}
      <div className="mb-6">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">Quick start</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {PRESETS.map((p, i) => (
            <button
              key={p.name}
              onClick={() => applyPreset(i)}
              className={`flex items-center gap-2.5 p-3 rounded-xl border text-left transition-all ${
                selectedPreset === i
                  ? 'bg-brand-950 border-brand-700 ring-1 ring-brand-500'
                  : 'bg-gray-900 border-gray-800 hover:border-gray-700'
              }`}
            >
              <span className="text-xl leading-none">{p.icon}</span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white truncate">{p.name}</p>
                <p className="text-[10px] text-gray-500 truncate">{p.desc}</p>
              </div>
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          <span>Moving an app from another MCPHub server?</span>
          <button
            type="button" onClick={() => fileRef.current?.click()} disabled={importingFile}
            className="flex items-center gap-1.5 text-brand-400 hover:text-brand-300 disabled:opacity-50"
          >
            {importingFile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Import an exported config (.mcphub.json)
          </button>
          <input
            ref={fileRef} type="file" accept=".json,application/json" className="hidden" aria-label="MCPHub config file"
            onChange={e => importFile(e.target.files?.[0])}
          />
        </div>
      </div>

      {/* Form */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
        <form onSubmit={submit} className="space-y-4">
          <Field label="App Name" required>
            <input
              type="text"
              placeholder="My Stripe Integration"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              required
              className="input"
            />
          </Field>

          <Field label="API Base URL" hint="e.g. https://api.stripe.com/v1" required>
            <input
              type="url"
              placeholder="https://api.example.com"
              value={form.baseUrl}
              onChange={e => set('baseUrl', e.target.value)}
              required
              className="input"
            />
          </Field>

          <Field
            label="OpenAPI / Swagger Spec URL"
            hint="Optional — automatically generates all tools from your spec"
          >
            <input
              type="url"
              placeholder="https://api.example.com/openapi.json"
              value={form.specUrl}
              onChange={e => set('specUrl', e.target.value)}
              className="input"
            />
          </Field>

          {/* Advanced */}
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            Advanced (auth settings)
          </button>

          {showAdvanced && (
            <div className="border-t border-gray-800 pt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Send key in">
                  <select
                    value={form.apiKeyIn}
                    onChange={e => {
                      const where = e.target.value as 'header' | 'query'
                      // Swap the default name too, unless the user typed their own.
                      setForm(f => ({
                        ...f,
                        apiKeyIn: where,
                        apiKeyHeader: ['Authorization', 'api_key', ''].includes(f.apiKeyHeader) ? (where === 'query' ? 'api_key' : 'Authorization') : f.apiKeyHeader,
                      }))
                    }}
                    className="input"
                  >
                    <option value="header">Header</option>
                    <option value="query">Query parameter</option>
                  </select>
                </Field>
                <Field label={form.apiKeyIn === 'query' ? 'Parameter name' : 'Header name'}>
                  <input
                    type="text"
                    placeholder={form.apiKeyIn === 'query' ? 'api_key' : 'Authorization'}
                    value={form.apiKeyHeader}
                    onChange={e => set('apiKeyHeader', e.target.value)}
                    className="input font-mono"
                  />
                </Field>
              </div>
              <Field
                label="API Key / Token"
                hint={form.apiKeyIn === 'query'
                  ? `Stored encrypted. Sent as ?${form.apiKeyHeader || 'api_key'}=… on every call; AI clients never see it.`
                  : 'Stored encrypted. "Authorization" sends Bearer <key>; other headers send it as-is.'}
              >
                <input
                  type="password"
                  placeholder="sk-... or Bearer token"
                  value={form.apiKey}
                  onChange={e => set('apiKey', e.target.value)}
                  className="input"
                />
              </Field>
            </div>
          )}

          {errMsg && (
            <div className="bg-red-950/50 border border-red-900 text-red-300 text-sm rounded-xl px-4 py-3">
              {typeof errMsg === 'string' ? errMsg : 'Validation error — check your inputs'}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white py-3 rounded-xl font-semibold transition-all hover:scale-[1.01]"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating MCP server...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                Generate MCP Server
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}

function Field({
  label, hint, required, children,
}: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
        {label}
        {required && <span className="text-brand-400 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-gray-600 mt-1">{hint}</p>}
    </div>
  )
}
