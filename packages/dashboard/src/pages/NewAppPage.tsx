import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Loader2, Zap, ChevronDown, ChevronUp } from 'lucide-react'
import { api, apiError } from '../lib/api.ts'
import { useToast } from '../components/Toast.tsx'

const PRESETS = [
  {
    name: 'Petstore (Demo)',
    baseUrl: 'https://petstore3.swagger.io/api/v3',
    specUrl: 'https://petstore3.swagger.io/api/v3/openapi.json',
    icon: '🐾',
    desc: '19 tools — great for testing',
  },
  {
    name: 'JSONPlaceholder',
    baseUrl: 'https://jsonplaceholder.typicode.com',
    specUrl: '',
    icon: '📋',
    desc: 'Free fake REST API for testing',
  },
  {
    name: 'Hacker News',
    baseUrl: 'https://hacker-news.firebaseio.com/v0',
    specUrl: '',
    icon: '📰',
    desc: 'Read HN stories and comments',
  },
  {
    name: 'Open Library',
    baseUrl: 'https://openlibrary.org',
    specUrl: '',
    icon: '📚',
    desc: 'Search millions of books',
  },
  {
    name: 'GitHub API',
    baseUrl: 'https://api.github.com',
    specUrl: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
    icon: '🐱',
    desc: 'Full GitHub REST API',
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
  })

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
        apiKeyHeader: form.apiKeyHeader || 'Authorization',
      })
      if (app.warning) {
        success('App created', app.warning)
      } else {
        success(`${app.toolCount} tools generated!`, `${app.name} is ready`)
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
                <Field label="Auth Header">
                  <input
                    type="text"
                    placeholder="Authorization"
                    value={form.apiKeyHeader}
                    onChange={e => set('apiKeyHeader', e.target.value)}
                    className="input"
                  />
                </Field>
                <Field label="API Key / Token" hint="Stored encrypted">
                  <input
                    type="password"
                    placeholder="sk-... or Bearer token"
                    value={form.apiKey}
                    onChange={e => set('apiKey', e.target.value)}
                    className="input"
                  />
                </Field>
              </div>
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
