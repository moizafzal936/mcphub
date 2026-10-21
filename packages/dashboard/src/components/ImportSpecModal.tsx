import { useState } from 'react'
import { FileUp, Loader2, X } from 'lucide-react'
import { api, apiError, type App, type McpTool } from '../lib/api.ts'
import { useToast } from './Toast.tsx'

export function ImportSpecModal({ app, onClose, onImported }: { app: App; onClose: () => void; onImported: (tools: McpTool[]) => void }) {
  const { success, error } = useToast()
  const [url, setUrl] = useState(app.specUrl ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      setErr('That file is larger than 10 MB')
      return
    }
    setText(await file.text())
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!confirm(`Importing replaces all ${app.toolCount ?? ''} existing tools of ${app.name}. Continue?`)) return
    setBusy(true)
    setErr('')
    try {
      const res = text.trim() ? await api.apps.importSpecText(app.id, text) : await api.apps.import(app.id, url.trim() || undefined)
      const skipped = res.skipped?.length ? ` Skipped: ${res.skipped.slice(0, 3).join(', ')}${res.skipped.length > 3 ? '…' : ''}` : ''
      success(`Imported ${res.imported} tools${res.format === 'postman' ? ' from Postman' : ''}`, skipped || undefined)
      onImported(res.tools ?? [])
      onClose()
    } catch (e) {
      setErr(apiError(e))
      error('Import failed', apiError(e))
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500'
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
      <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl my-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white flex items-center gap-2"><FileUp className="w-4 h-4 text-brand-400" />Import OpenAPI spec or Postman collection</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-gray-400">Public spec URL</span>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.example.com/openapi.json" disabled={!!text.trim()} className={`mt-1 ${field} disabled:opacity-40`} />
          </label>
          <div className="text-center text-xs text-gray-600">or, for specs on a private network</div>
          <label className="block">
            <span className="text-xs font-medium text-gray-400">Upload an OpenAPI (JSON/YAML) or Postman collection file</span>
            <input type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" onChange={onFile} className="mt-1 block w-full text-xs text-gray-400 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-800 file:px-3 file:py-1.5 file:text-gray-200" />
          </label>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={6} spellCheck={false} aria-label="Spec text"
            placeholder="…or paste an OpenAPI spec or Postman collection here" className={`${field} font-mono text-xs`} />
          {err && <p className="text-sm text-red-400" role="alert">{err}</p>}
          <button type="submit" disabled={busy || (!text.trim() && !url.trim())} className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white py-2.5 rounded-xl text-sm font-medium">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Import and replace tools
          </button>
        </div>
      </form>
    </div>
  )
}
