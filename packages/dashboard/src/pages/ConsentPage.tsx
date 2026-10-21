import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plug, Loader2, ShieldCheck, ExternalLink } from 'lucide-react'
import { Logo } from '../components/Brand.tsx'
import { api, apiError, type ConsentRequest } from '../lib/api.ts'
import { useAuth } from '../components/Auth.tsx'

export default function ConsentPage() {
  const [params] = useSearchParams()
  const { user } = useAuth()
  const requestId = params.get('request') ?? ''
  const [req, setReq] = useState<ConsentRequest | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)

  useEffect(() => {
    if (!requestId) {
      setErr('Missing authorization request.')
      return
    }
    api.oauth.request(requestId).then(setReq).catch(e => setErr(apiError(e)))
  }, [requestId])

  async function decide(approve: boolean) {
    setBusy(approve ? 'approve' : 'deny')
    try {
      const { redirectUrl } = await api.oauth.decide(requestId, approve)
      window.location.assign(redirectUrl)
    } catch (e) {
      setErr(apiError(e))
      setBusy(null)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-8">
          <Logo size="lg" />
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          {err ? (
            <p className="text-sm text-red-400" role="alert">{err}</p>
          ) : !req ? (
            <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 text-gray-600 animate-spin" /></div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-1">
                <ShieldCheck className="w-5 h-5 text-brand-400" />
                <h1 className="text-lg font-semibold text-white">Connect {req.clientName}?</h1>
              </div>
              <p className="text-sm text-gray-400 mt-2">
                <span className="text-white font-medium">{req.clientName}</span> wants to use the MCP tools of{' '}
                <span className="text-white font-medium">{req.app.name}</span>.
              </p>
              <ul className="mt-4 space-y-2 text-sm text-gray-400">
                <li>• It can call the {req.app.name} API (<span className="font-mono text-xs text-gray-500">{req.app.baseUrl}</span>) using the credential you stored.</li>
                <li>• It cannot see that credential, your other apps, or your account.</li>
                <li>• You can disconnect it at any time from the app's Connect tab.</li>
              </ul>
              <div className="mt-4 flex items-center gap-1.5 text-xs text-gray-500">
                <ExternalLink className="w-3.5 h-3.5" />
                You'll be sent back to <span className="font-mono text-gray-300">{req.redirectHost}</span>
              </div>
              <p className="mt-1 text-xs text-gray-600">Signed in as {user?.email}</p>
              <div className="mt-6 grid grid-cols-2 gap-2">
                <button
                  onClick={() => decide(false)} disabled={busy !== null}
                  className="py-2.5 rounded-lg text-sm font-medium border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                >
                  {busy === 'deny' ? 'Cancelling…' : 'Cancel'}
                </button>
                <button
                  onClick={() => decide(true)} disabled={busy !== null}
                  className="flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-500 text-onaccent disabled:opacity-50"
                >
                  {busy === 'approve' && <Loader2 className="w-4 h-4 animate-spin" />}
                  Allow access
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
