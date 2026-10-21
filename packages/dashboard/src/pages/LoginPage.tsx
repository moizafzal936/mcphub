import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plug, Loader2 } from 'lucide-react'
import { Logo } from '../components/Brand.tsx'
import { api, apiError } from '../lib/api.ts'
import { useAuth } from '../components/Auth.tsx'

export default function LoginPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { setUser } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [signupOpen, setSignupOpen] = useState(false)
  const [bootstrap, setBootstrap] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [needCode, setNeedCode] = useState(false)
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')

  const rawNext = params.get('next') ?? '/dashboard'
  // Only same-app paths: no protocol-relative "//", backslashes or control characters (open redirect).
  const next = /^\/(?![/\\])[^\\\x00-\x1f]*$/.test(rawNext) ? rawNext : '/dashboard'

  useEffect(() => {
    api.auth.status().then(s => {
      setSignupOpen(s.signupOpen)
      setBootstrap(s.bootstrap)
      setNeedsSetup(!!s.needsSetup)
      if (s.bootstrap) setMode('register')
    }).catch(() => {})
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      const user = mode === 'login' ? await api.auth.login(email, password, needCode ? code : undefined) : await api.auth.register(email, password)
      setUser(user)
      navigate(next, { replace: true })
    } catch (e: any) {
      if (e?.response?.data?.twoFactorRequired) {
        setErr(needCode ? apiError(e) : '')
        setNeedCode(true)
        setCode('')
      } else {
        setErr(apiError(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link to="/" className="flex justify-center mb-8" aria-label="MCPHub home">
          <Logo size="lg" />
        </Link>
        <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-white">{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
            {needsSetup && (
              <p className="text-xs text-amber-400 mt-2">
                This server has no accounts yet. Create the operator account on the server with
                <code className="block mt-1 text-[11px] text-gray-400 break-all">docker compose exec mcphub node packages/server/dist/cli/create-operator.js you@example.com</code>
              </p>
            )}
            {bootstrap && (
              <p className="text-xs text-gray-500 mt-1">No accounts exist yet. The first account becomes this server's operator.</p>
            )}
          </div>
          <label className="block">
            <span className="text-xs font-medium text-gray-400">Email</span>
            <input
              type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
              className="mt-1 w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-400">Password</span>
            <input
              type="password" required minLength={mode === 'register' ? 10 : 1}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password} onChange={e => setPassword(e.target.value)}
              className="mt-1 w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {mode === 'register' && <span className="text-[11px] text-gray-600">At least 10 characters</span>}
          </label>
          {needCode && mode === 'login' && (
            <label className="block">
              <span className="text-xs font-medium text-gray-400">Authenticator code</span>
              <input
                inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} required placeholder="123456"
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                className="mt-1 w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white font-mono tracking-widest focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </label>
          )}
          {err && <p className="text-sm text-red-400" role="alert">{err}</p>}
          <button
            type="submit" disabled={busy}
            className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-onaccent py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
          {signupOpen && !bootstrap && (
            <button
              type="button" onClick={() => { setMode(m => (m === 'login' ? 'register' : 'login')); setErr('') }}
              className="w-full text-xs text-gray-500 hover:text-gray-300"
            >
              {mode === 'login' ? 'Need an account? Create one' : 'Have an account? Sign in'}
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
