import { useState } from 'react'
import { Loader2, X, TerminalSquare } from 'lucide-react'
import { api, apiError, type App, type McpTool } from '../lib/api.ts'
import { useToast } from './Toast.tsx'

export function CurlImportModal({ app, onClose, onAdded }: { app: App; onClose: () => void; onAdded: (tool: McpTool) => void }) {
  const { success, error } = useToast()
  const [curl, setCurl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const res = await api.tools.fromCurl(app.id, curl, name.trim() || undefined)
      const skipped = res.skippedHeaders.length ? ` Skipped ${res.skippedHeaders.join(', ')} — the app's stored credential is used instead.` : ''
      success(`Created ${res.tool.name}`, `${res.tool.parameters.length + Object.keys((res.tool.requestBodySchema as any)?.properties ?? {}).length} parameters detected.${skipped}`)
      onAdded(res.tool)
      onClose()
    } catch (e) {
      setErr(apiError(e))
      error('Could not create tool', apiError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
      <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl my-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white flex items-center gap-2"><TerminalSquare className="w-4 h-4 text-brand-400" />Create tool from curl</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-500">
            Paste a curl example from {app.name}'s docs. The URL must start with <code className="text-gray-300 font-mono">{app.baseUrl}</code>.
            IDs in the path become parameters; auth headers are ignored in favour of the app's stored key.
          </p>
          <textarea
            value={curl} onChange={e => setCurl(e.target.value)} required rows={7} spellCheck={false} aria-label="curl command"
            placeholder={`curl -X POST ${app.baseUrl}/users/123/notes \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -d '{"text": "hello"}'`}
            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <input
            value={name} onChange={e => setName(e.target.value)} placeholder="Tool name (optional, e.g. create_note)" aria-label="Tool name"
            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          {err && <p className="text-sm text-red-400" role="alert">{err}</p>}
          <button type="submit" disabled={busy || !curl.trim()} className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white py-2.5 rounded-xl text-sm font-medium">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Create tool
          </button>
        </div>
      </form>
    </div>
  )
}
