import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Download, Eye, KeyRound, Loader2, ShieldCheck, Trash2 } from 'lucide-react'
import { api, apiError, type App } from '../lib/api.ts'
import { useToast } from './Toast.tsx'
import { OAuthFields, fromOAuthForm, toOAuthForm } from './OAuthFields.tsx'

const inputCls = 'w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500'

export function SettingsPanel({ app, onUpdated }: { app: App; onUpdated: (app: App) => void }) {
  const { success, error } = useToast()
  const navigate = useNavigate()
  const [name, setName] = useState(app.name)
  const [header, setHeader] = useState(app.apiKeyHeader)
  const [keyIn, setKeyIn] = useState<'header' | 'query'>(app.apiKeyIn ?? 'header')
  const [rate, setRate] = useState(app.rateLimitPerMin?.toString() ?? '')
  const [newKey, setNewKey] = useState('')
  const [authType, setAuthType] = useState<NonNullable<App['authType']>>(app.authType ?? 'api_key')
  const [oauth, setOauth] = useState(toOAuthForm(app.oauth))
  const [busy, setBusy] = useState<'save' | 'auth' | 'key' | 'clear' | 'delete' | 'export' | 'duplicate' | 'test' | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const usesOAuth = app.authType === 'oauth2_client_credentials'
  const secretWord = usesOAuth ? 'client secret' : 'API key'

  async function save(patch: Parameters<typeof api.apps.update>[1], kind: 'save' | 'auth' | 'key' | 'clear', message: string) {
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
    save({ name: name.trim(), rateLimitPerMin: rateValue }, 'save', 'Settings saved')
  }

  function saveAuth(e: React.FormEvent) {
    e.preventDefault()
    setTestResult(null)
    save(
      authType === 'oauth2_client_credentials'
        ? { authType, oauth: fromOAuthForm(oauth) }
        : { authType, apiKeyIn: keyIn, apiKeyHeader: header.trim() },
      'auth', 'Authentication saved'
    )
  }

  async function testToken() {
    setBusy('test')
    setTestResult(null)
    try {
      const r = await api.apps.testAuth(app.id)
      setTestResult(r.ok
        ? { ok: true, text: `Got a ${r.tokenType} token, valid for ${Math.round((r.expiresIn ?? 0) / 60)} min${r.scope ? ` · scope: ${r.scope}` : ''}` }
        : { ok: false, text: r.error ?? 'Token request failed' })
    } catch (err) {
      setTestResult({ ok: false, text: apiError(err) })
    } finally {
      setBusy(null)
    }
  }

  async function exportConfig() {
    setBusy('export')
    try {
      const config = await api.apps.exportConfig(app.id)
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app'}.mcphub.json`
      a.click()
      URL.revokeObjectURL(url)
      success('Config downloaded', 'Import it on another MCPHub server from Connect API')
    } catch (err) {
      error('Could not export', apiError(err))
    } finally {
      setBusy(null)
    }
  }

  async function duplicate() {
    setBusy('duplicate')
    try {
      const config = await api.apps.exportConfig(app.id) as { app: { name: string } }
      config.app.name = `${app.name} (copy)`.slice(0, 100)
      const copy = await api.apps.importConfig(JSON.stringify(config))
      success('App duplicated', app.hasApiKey ? 'Add the API key in the copy\'s Settings' : copy.name)
      navigate(`/apps/${copy.id}?tab=settings`)
    } catch (err) {
      error('Could not duplicate', apiError(err))
    } finally {
      setBusy(null)
    }
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
          <span className="text-xs font-medium text-gray-400">Rate limit (tool calls per minute)</span>
          <input value={rate} onChange={e => setRate(e.target.value)} inputMode="numeric" placeholder="Server default" className={`mt-1 ${inputCls}`} />
        </label>
        <button type="submit" disabled={busy !== null} className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium">
          {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />}
          Save settings
        </button>
      </form>

      <form onSubmit={saveAuth} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-brand-400" />
          <h2 className="font-semibold text-white">Upstream authentication</h2>
        </div>
        <label className="block">
          <span className="text-xs font-medium text-gray-400">Method</span>
          <select value={authType} onChange={e => setAuthType(e.target.value as NonNullable<App['authType']>)} className={`mt-1 ${inputCls}`}>
            <option value="api_key">API key or token</option>
            <option value="oauth2_client_credentials">OAuth 2.0 client credentials</option>
          </select>
        </label>
        {authType === 'oauth2_client_credentials' ? (
          <>
            <OAuthFields value={oauth} onChange={setOauth} inputClass={inputCls} />
            <p className="text-[11px] text-gray-600">
              MCPHub exchanges the client ID and secret for an access token, caches it until shortly before it expires and sends it as <code>Bearer</code>.
              AI clients never see the secret or the token.
            </p>
          </>
        ) : (<>
        <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-400">Send API key in</span>
            <select
              value={keyIn}
              onChange={e => {
                const where = e.target.value as 'header' | 'query'
                setKeyIn(where)
                if (['Authorization', 'api_key', ''].includes(header)) setHeader(where === 'query' ? 'api_key' : 'Authorization')
              }}
              className={`mt-1 ${inputCls}`}
            >
              <option value="header">Header</option>
              <option value="query">Query parameter</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-400">{keyIn === 'query' ? 'Parameter name' : 'Header name'}</span>
            <input value={header} onChange={e => setHeader(e.target.value)} maxLength={256} required className={`mt-1 ${inputCls} font-mono`} />
          </label>
        </div>
        <p className="text-[11px] text-gray-600 -mt-2">
          {keyIn === 'query'
            ? <>Every call adds <code>?{header || 'api_key'}=&lt;key&gt;</code>. A parameter with that name is hidden from AI clients, and the key is redacted from previews and logs.</>
            : <>"Authorization" sends <code>Bearer &lt;key&gt;</code>; any other header (e.g. X-API-Key) sends the key as-is.</>}
        </p>
        </>)}
        <button type="submit" disabled={busy !== null} className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium">
          {busy === 'auth' && <Loader2 className="w-4 h-4 animate-spin" />}
          Save authentication
        </button>
      </form>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox" className="mt-1" checked={!!app.readOnly} disabled={busy !== null}
            onChange={e => save({ readOnly: e.target.checked }, 'save', e.target.checked ? 'Read-only mode on' : 'Read-only mode off')}
          />
          <span>
            <span className="flex items-center gap-2 font-semibold text-white"><Eye className="w-4 h-4 text-brand-400" />Read-only mode</span>
            <span className="block text-sm text-gray-500 mt-1">
              AI clients only see GET tools, and POST/PUT/PATCH/DELETE calls are refused by the server. Useful for demos against real data.
              You can still run any tool from the Test tab.
            </span>
          </span>
        </label>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-brand-400" />
          <h2 className="font-semibold text-white">{usesOAuth ? 'Client secret' : 'Upstream API key'}</h2>
        </div>
        <p className="text-sm text-gray-500">
          {app.hasApiKey
            ? `A ${secretWord} is stored, encrypted. It is never shown again; replace it here if it was rotated or mistyped.`
            : usesOAuth ? 'No client secret stored yet. Calls fail until you add one.' : 'No key stored. Requests are sent without credentials.'}
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="password" autoComplete="off" value={newKey} onChange={e => setNewKey(e.target.value)}
            placeholder={app.hasApiKey ? `New ${secretWord}` : usesOAuth ? 'Client secret' : 'API key'} aria-label={`New ${secretWord}`} className={inputCls}
          />
          <button
            onClick={() => save({ apiKey: newKey }, 'key', app.hasApiKey ? `${usesOAuth ? 'Client secret' : 'API key'} replaced` : `${usesOAuth ? 'Client secret' : 'API key'} saved`)}
            disabled={!newKey || busy !== null}
            className="flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap"
          >
            {busy === 'key' && <Loader2 className="w-4 h-4 animate-spin" />}
            {app.hasApiKey ? 'Replace' : 'Save'}
          </button>
        </div>
        {usesOAuth && app.hasApiKey && (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={testToken} disabled={busy !== null}
              className="flex items-center gap-2 border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-50 px-3 py-1.5 rounded-lg text-xs font-medium">
              {busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              Test token
            </button>
            {testResult && <span className={`text-xs ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>{testResult.text}</span>}
          </div>
        )}
        {app.hasApiKey && (
          <button
            onClick={() => confirm(`Remove the stored ${secretWord}?`) && save({ apiKey: null }, 'clear', `${usesOAuth ? 'Client secret' : 'API key'} removed`)}
            disabled={busy !== null}
            className="text-xs text-gray-500 hover:text-red-400"
          >
            Remove stored {secretWord}
          </button>
        )}
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
        <h2 className="font-semibold text-white">Export &amp; duplicate</h2>
        <p className="text-sm text-gray-500">
          Download this app's settings and tools as a file to set it up on another MCPHub server, or make a copy here to experiment.
          The API key is never included.
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={exportConfig} disabled={busy !== null} className="flex items-center gap-2 border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium">
            {busy === 'export' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download config
          </button>
          <button onClick={duplicate} disabled={busy !== null} className="flex items-center gap-2 border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium">
            {busy === 'duplicate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
            Duplicate app
          </button>
        </div>
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
