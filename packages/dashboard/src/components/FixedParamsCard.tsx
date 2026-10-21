import { useState } from 'react'
import { Loader2, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { api, apiError, type App } from '../lib/api.ts'
import { useToast } from './Toast.tsx'

const MAX = 20
type Row = { in: 'header' | 'query'; name: string; value: string; secret: boolean; hasValue: boolean }

const toRows = (app: App): Row[] =>
  (app.fixedParams ?? []).map(f => ({ in: f.in, name: f.name, value: f.secret ? '' : f.value ?? '', secret: f.secret, hasValue: !!f.hasValue }))

/** Headers and query parameters MCPHub adds to every call, e.g. an API version or a second credential. */
export function FixedParamsCard({ app, onUpdated, inputClass }: { app: App; onUpdated: (app: App) => void; inputClass: string }) {
  const { success, error } = useToast()
  const [rows, setRows] = useState<Row[]>(() => toRows(app))
  const [saving, setSaving] = useState(false)
  const update = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await api.apps.update(app.id, {
        fixedParams: rows.map(r => ({ in: r.in, name: r.name.trim(), secret: r.secret, value: r.value || (r.secret ? null : '') })),
      })
      onUpdated({ ...app, ...updated })
      setRows(toRows({ ...app, ...updated }))
      success('Fixed parameters saved', `${rows.length} sent with every call`)
    } catch (err) {
      error('Could not save', apiError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="w-4 h-4 text-brand-400" />
        <h2 className="font-semibold text-white">Fixed headers &amp; query parameters</h2>
      </div>
      <p className="text-sm text-gray-500">
        Sent with every call, e.g. <code>Notion-Version</code>, <code>api-version</code> or a second key. AI clients can't see or change them.
        Mark credentials as secret: they are encrypted and never shown again.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[6.5rem_1fr] sm:grid-cols-[6.5rem_1fr_1.3fr_auto_auto] items-center gap-2 border-t border-gray-800 pt-3 sm:border-0 sm:pt-0">
          <select value={r.in} onChange={e => update(i, { in: e.target.value as Row['in'] })} aria-label="Sent in" className={inputClass}>
            <option value="header">Header</option>
            <option value="query">Query</option>
          </select>
          <input value={r.name} onChange={e => update(i, { name: e.target.value })} placeholder={r.in === 'header' ? 'Notion-Version' : 'api-version'}
            aria-label="Name" maxLength={128} required className={`${inputClass} font-mono`} />
          <input
            type={r.secret ? 'password' : 'text'} autoComplete="off" value={r.value} onChange={e => update(i, { value: e.target.value })}
            placeholder={r.secret && r.hasValue ? 'Stored — leave empty to keep' : 'Value'} aria-label="Value" maxLength={4096}
            className={`${inputClass} col-span-2 sm:col-span-1 font-mono`}
          />
          <label className="flex items-center gap-1.5 text-xs text-gray-400 whitespace-nowrap">
            <input type="checkbox" checked={r.secret} onChange={e => update(i, { secret: e.target.checked, ...(e.target.checked ? {} : { hasValue: false }) })} />
            Secret
          </label>
          <button type="button" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} aria-label={`Remove ${r.name || 'parameter'}`}
            className="justify-self-end text-gray-600 hover:text-red-400 p-1">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" disabled={rows.length >= MAX} onClick={() => setRows(rs => [...rs, { in: 'header', name: '', value: '', secret: false, hasValue: false }])}
          className="flex items-center gap-1.5 border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-50 px-3 py-1.5 rounded-lg text-xs font-medium">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
        <button type="submit" disabled={saving} className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-onaccent px-4 py-1.5 rounded-lg text-sm font-medium">
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Save
        </button>
        {rows.some(r => r.secret && !r.hasValue && !r.value) && (
          <span className="text-xs text-amber-400">Secrets without a value are not sent until you add one.</span>
        )}
      </div>
    </form>
  )
}
