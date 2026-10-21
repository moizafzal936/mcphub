import { useMemo, useState } from 'react'
import { Loader2, Scissors, X } from 'lucide-react'
import { api, apiError, type McpTool } from '../lib/api.ts'
import { discoverFields, formatSize, projectResponse } from '../lib/shape.ts'
import { useToast } from './Toast.tsx'

const MAX_FIELDS = 100

/** Lets the owner choose which response fields AI clients receive, based on a real response. */
export function ResponseShapeModal({ appId, tool, sample, onClose, onSaved }: {
  appId: string
  tool: McpTool
  sample: unknown
  onClose: () => void
  onSaved: (fields: string[] | undefined) => void
}) {
  const { success, error } = useToast()
  const fields = useMemo(() => discoverFields(sample), [sample])
  const [chosen, setChosen] = useState<Set<string>>(new Set(tool.responseFields ?? []))
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)

  const covered = (path: string) => [...chosen].some(c => path !== c && path.startsWith(`${c}.`))
  const fullSize = useMemo(() => JSON.stringify(sample, null, 2).length, [sample])
  const shaped = useMemo(() => projectResponse(sample, [...chosen]), [sample, chosen])
  const shapedSize = JSON.stringify(shaped, null, 2).length
  const needle = filter.trim().toLowerCase()
  const shown = needle ? fields.filter(f => f.path.toLowerCase().includes(needle)) : fields

  function toggle(path: string) {
    setChosen(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        // Choosing a parent includes everything under it.
        for (const c of next) if (c.startsWith(`${path}.`)) next.delete(c)
        next.add(path)
      }
      return next
    })
  }

  async function save(fieldsToSave: string[]) {
    setSaving(true)
    try {
      await api.tools.setResponseFields(appId, tool.id, fieldsToSave.length ? fieldsToSave : null)
      onSaved(fieldsToSave.length ? fieldsToSave : undefined)
      success(fieldsToSave.length ? 'Response shaped for AI' : 'AI gets the full response', tool.name)
      onClose()
    } catch (err) {
      error('Could not save', apiError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Choose response fields">
      <div className="bg-gray-900 border border-gray-800 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-start gap-3 px-5 py-4 border-b border-gray-800">
          <Scissors className="w-4 h-4 text-brand-400 mt-1 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-white">Choose what the AI receives</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              From the last <code>{tool.name}</code> response. Lists are kept item by item. Errors always go through in full.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-3 border-b border-gray-800 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-gray-400">Full: <span className="text-white font-medium">{formatSize(fullSize)}</span></span>
          <span className="text-gray-400">AI gets: <span className={`font-medium ${chosen.size ? 'text-green-400' : 'text-white'}`}>{formatSize(shapedSize)}</span></span>
          {chosen.size > 0 && shapedSize < fullSize && (
            <span className="text-green-400">{Math.round((1 - shapedSize / fullSize) * 100)}% smaller</span>
          )}
        </div>

        <div className="px-5 pt-3">
          <input
            value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter fields…" aria-label="Filter fields"
            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-2">
          {fields.length === 0 && <p className="text-xs text-gray-500 py-6 text-center">This response has no JSON fields to choose from.</p>}
          {shown.map(f => {
            const inherited = covered(f.path)
            return (
              <label key={f.path} className={`flex items-center gap-2 py-1 text-xs ${inherited ? 'opacity-60' : 'cursor-pointer'}`} style={{ paddingLeft: needle ? 0 : f.depth * 16 }}>
                <input type="checkbox" checked={inherited || chosen.has(f.path)} disabled={inherited || (!chosen.has(f.path) && chosen.size >= MAX_FIELDS)} onChange={() => toggle(f.path)} />
                <code className="text-gray-200">{needle ? f.path : f.key}</code>
                <span className="text-gray-600">{f.kind}</span>
                {f.sample !== undefined && <span className="text-gray-500 truncate min-w-0">{f.sample}</span>}
              </label>
            )
          })}
        </div>

        {chosen.size > 0 && (
          <pre className="mx-5 mb-3 max-h-32 overflow-auto bg-gray-950 border border-gray-800 rounded-lg p-3 text-[11px] text-gray-400 font-mono">
            {JSON.stringify(shaped, null, 2).slice(0, 2000)}
          </pre>
        )}

        <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-gray-800">
          <span className="text-xs text-gray-500 mr-auto">{chosen.size ? `${chosen.size} field${chosen.size === 1 ? '' : 's'} chosen` : 'Nothing chosen: the AI gets the full response'}</span>
          {(tool.responseFields?.length ?? 0) > 0 && (
            <button onClick={() => save([])} disabled={saving} className="text-xs text-gray-400 hover:text-white px-3 py-1.5">Send everything</button>
          )}
          <button onClick={onClose} className="text-xs text-gray-400 hover:text-white px-3 py-1.5">Cancel</button>
          <button
            onClick={() => save([...chosen])} disabled={saving || chosen.size === 0}
            className="flex items-center gap-1.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-onaccent text-xs font-medium px-4 py-1.5 rounded-lg"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
