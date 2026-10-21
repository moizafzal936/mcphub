import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { KeyRound, Loader2, Trash2 } from 'lucide-react'
import { api, apiError, type App } from '../lib/api.ts'
import { useToast } from './Toast.tsx'

const inputCls = 'w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500'

export function SettingsPanel({ app, onUpdated }: { app: App; onUpdated: (app: App) => void }) {
  const { success, error } = useToast()
  const navigate = useNavigate()
  const [name, setName] = useState(app.name)
  const [header, setHeader] = useState(app.apiKeyHeader)
  const [rate, setRate] = useState(app.rateLimitPerMin?.toString() ?? '')
  const [newKey, setNewKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'key' | 'clear' | 'delete' | null>(null)

  async function save(patch: Parameters<typeof api.apps.update>[1], kind: 'save' | 'key' | 'clear', message: string) {
    setBusy(kind)
    try {
      const updated = await api.apps.update(app.id, patch)
      onUpdated({ ...app, ...updated })
      success(message, updated.name)
      if (kind === 'key') setNewKey('')
    } catch (err) {
      error('Could not save', apiError(err))
    } finally {
      setBusy(null)
    }
  }

  function saveGeneral(e: React.FormEvent) {
    e.preventDefault()
    const rateValue = rate.trim() === '' ? null : Number(rate)
    if (rateValue !== null && (!Number.isInteger(rateValue) || rateValue < 1)) {
      error('Invalid rate limit', 'Use a whole number of calls per minute, or leave it blank for the server default')
      return
    }
    save({ name: name.trim(), apiKeyHeader: header.trim(), rateLimitPerMin: rateValue }, 'save', 'Settings saved')
  }

  async function remove() {
    if (!confirm(`Delete ${app.name}? Its tools, logs, tokens and connected clients are removed. This cannot be undone.`)) return
    setBusy('delete')
    try {
      await api.apps.delete(app.id)
      success('App deleted', app.name)
      navigate('/dashboard')
    } catch (err) {
      error('Could not delete', apiError(err))
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      <form onSubmit={saveGeneral} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
        <h2 className="font-semibold text-white">General</h2>
        <label className="block">
          <span className="text-xs font-medium text-gray-400">App name</span>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={100} required className={`mt-1 ${inputCls}`} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-400">Credential header</span>
          <input value={header} onChange={e => setHeader(e.target.value)} maxLength={256} required className={`mt-1 ${inputCls} font-mono`} />
          <span className="text-[11px] text-gray-600">"Authorization" sends <code>Bearer &lt;key&gt;</code>; any other header (e.g. X-API-Key) sends the key as-is.</span>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-400">Rate limit (tool calls per minute)</span>
          <input value={rate} onChange={e => setRate(e.target.value)} inputMode="numeric" placeholder="Server default" className={`mt-1 ${inputCls}`} />
        </label>
        <button type="submit" disabled={busy !== null} className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium">
          {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />}
          Save settings
        </button>
      </form>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-brand-400" />
          <h2 className="font-semibold text-white">Upstream API key</h2>
        </div>
        <p className="text-sm text-gray-500">
          {app.hasApiKey
            ? 'A key is stored, encrypted. It is never shown again; replace it here if it was rotated or mistyped.'
            : 'No key stored. Requests are sent without credentials.'}
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="password" autoComplete="off" value={newKey} onChange={e => setNewKey(e.target.value)}
            placeholder={app.hasApiKey ? 'New API key' : 'API key'} aria-label="New API key" className={inputCls}
          />
          <button
            onClick={() => save({ apiKey: newKey }, 'key', app.hasApiKey ? 'API key replaced' : 'API key saved')}
            disabled={!newKey || busy !== null}
            className="flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap"
          >
            {busy === 'key' && <Loader2 className="w-4 h-4 animate-spin" />}
            {app.hasApiKey ? 'Replace key' : 'Save key'}
          </button>
        </div>
        {app.hasApiKey && (
          <button
            onClick={() => confirm('Remove the stored API key?') && save({ apiKey: null }, 'clear', 'API key removed')}
            disabled={busy !== null}
            className="text-xs text-gray-500 hover:text-red-400"
          >
            Remove stored key
          </button>
        )}
      </div>

      <div className="bg-gray-900 border border-red-950 rounded-xl p-6">
        <h2 className="font-semibold text-white mb-1">Delete app</h2>
        <p className="text-sm text-gray-500 mb-3">Removes its tools, logs, access tokens and connected clients.</p>
        <button onClick={remove} disabled={busy !== null} className="flex items-center gap-2 border border-red-900 text-red-400 hover:bg-red-950 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium">
          {busy === 'delete' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          Delete app
        </button>
      </div>
    </div>
  )
}
