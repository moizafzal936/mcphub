import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { ShieldCheck, Loader2 } from 'lucide-react'
import { api, apiError } from '../lib/api.ts'
import { useAuth } from '../components/Auth.tsx'
import { useToast } from '../components/Toast.tsx'

const inputCls = 'w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500'

export default function AccountPage() {
  const { user, setUser } = useAuth()
  const { success, error } = useToast()
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const enabled = !!user?.twoFactorEnabled

  useEffect(() => {
    api.auth.me().then(setUser).catch(() => {})
  }, [])

  async function start() {
    setBusy(true)
    try {
      const { secret, otpauthUrl } = await api.auth.twoFactorSetup()
      setSetup({ secret, qr: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 192 }) })
    } catch (err) {
      error('Could not start setup', apiError(err))
    } finally {
      setBusy(false)
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      if (enabled) {
        await api.auth.twoFactorDisable(password, code)
        success('Two-factor disabled')
      } else {
        await api.auth.twoFactorEnable(code)
        success('Two-factor enabled', 'You will need a code each time you sign in')
        setSetup(null)
      }
      setCode('')
      setPassword('')
      setUser(await api.auth.me())
    } catch (err) {
      error('Could not save', apiError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-lg space-y-5">
      <h1 className="text-2xl font-bold text-white">Account</h1>
      <p className="text-sm text-gray-500">Signed in as {user?.email}</p>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-brand-400" />
          <h2 className="font-semibold text-white">Two-factor authentication</h2>
          <span className={`ml-auto text-xs px-2 py-0.5 rounded ${enabled ? 'bg-green-950 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
            {enabled ? 'on' : 'off'}
          </span>
        </div>
        <p className="text-sm text-gray-500">
          Require a 6-digit code from an authenticator app (1Password, Google Authenticator, Authy) when signing in.
        </p>

        {!enabled && !setup && (
          <button onClick={start} disabled={busy} className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-onaccent px-4 py-2 rounded-lg text-sm font-medium">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Set up two-factor
          </button>
        )}

        {!enabled && setup && (
          <div className="space-y-3">
            <p className="text-sm text-gray-400">1. Scan this with your authenticator app:</p>
            <img src={setup.qr} alt="Two-factor setup QR code" className="w-48 h-48 rounded-lg bg-paper p-1" />
            <p className="text-xs text-gray-500">
              Or enter this key manually: <code className="font-mono text-gray-300 break-all">{setup.secret}</code>
            </p>
            <p className="text-sm text-gray-400">2. Enter the 6-digit code it shows:</p>
          </div>
        )}

        {(enabled || setup) && (
          <form onSubmit={confirm} className="space-y-3">
            {enabled && (
              <input type="password" autoComplete="current-password" placeholder="Password" aria-label="Password"
                value={password} onChange={e => setPassword(e.target.value)} required className={inputCls} />
            )}
            <input inputMode="numeric" autoComplete="one-time-code" placeholder="123456" aria-label="Authenticator code" maxLength={6}
              value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} required className={`${inputCls} font-mono tracking-widest`} />
            <button type="submit" disabled={busy || code.length !== 6}
              className={`flex items-center gap-2 disabled:opacity-50 text-onaccent px-4 py-2 rounded-lg text-sm font-medium ${enabled ? 'bg-red-700 hover:bg-red-600' : 'bg-brand-600 hover:bg-brand-500'}`}>
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {enabled ? 'Turn off two-factor' : 'Verify and turn on'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
