import { useEffect, useRef, useState } from 'react'
import { Loader2, Send, Sparkles } from 'lucide-react'
import { api, apiError, type App, type PlaygroundStep } from '../lib/api.ts'

interface Turn {
  role: 'user' | 'assistant'
  content: string
  steps?: PlaygroundStep[]
}

export function PlaygroundPanel({ app }: { app: App }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.playground.status().then(s => setEnabled(s.enabled)).catch(() => setEnabled(false))
  }, [])
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, busy])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text) return
    const next = [...turns, { role: 'user' as const, content: text }]
    setTurns(next)
    setInput('')
    setErr('')
    setBusy(true)
    try {
      const res = await api.playground.run(app.id, next.slice(-20).map(t => ({ role: t.role, content: t.content })))
      setTurns(t => [...t, { role: 'assistant', content: res.reply || '(no text reply)', steps: res.steps }])
    } catch (e) {
      setErr(apiError(e))
    } finally {
      setBusy(false)
    }
  }

  if (enabled === false) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-sm text-gray-400 space-y-2">
        <div className="flex items-center gap-2 text-white font-semibold"><Sparkles className="w-4 h-4 text-brand-400" />Playground</div>
        <p>Chat with Claude using this app's tools, right here. To turn it on, set <code className="text-gray-300">ANTHROPIC_API_KEY</code> in the server's environment and restart it.</p>
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl flex flex-col" style={{ height: 'calc(100vh - 320px)', minHeight: '420px' }}>
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {turns.length === 0 && (
          <div className="text-center text-sm text-gray-500 py-10">
            <Sparkles className="w-5 h-5 text-brand-400 mx-auto mb-2" />
            Ask Claude to do something with {app.name}. It will call your tools live.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === 'user' ? 'flex justify-end' : ''}>
            <div className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${t.role === 'user' ? 'bg-brand-600 text-onaccent' : 'bg-gray-950 border border-gray-800 text-gray-200'}`}>
              {t.steps && t.steps.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {t.steps.map((s, j) => (
                    <span key={j} title={JSON.stringify(s.input)}
                      className={`text-[11px] font-mono px-2 py-0.5 rounded ${s.statusCode > 0 && s.statusCode < 400 ? 'bg-green-950 text-green-400' : 'bg-red-950 text-red-400'}`}>
                      {s.tool} · {s.statusCode || 'ERR'} · {s.durationMs}ms
                    </span>
                  ))}
                </div>
              )}
              {t.content}
            </div>
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" />Claude is working…</div>}
        {err && <p className="text-sm text-red-400" role="alert">{err}</p>}
        <div ref={endRef} />
      </div>
      <form onSubmit={send} className="border-t border-gray-800 p-3 flex gap-2">
        <input value={input} onChange={e => setInput(e.target.value)} maxLength={4000} disabled={busy || enabled === null}
          placeholder={`e.g. "Show me 3 available pets"`} aria-label="Message"
          className="flex-1 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500" />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send"
          className="flex items-center gap-1.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-onaccent px-4 py-2 rounded-lg text-sm font-medium">
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  )
}
