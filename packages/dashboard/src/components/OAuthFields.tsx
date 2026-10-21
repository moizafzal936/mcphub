import type { App } from '../lib/api.ts'

export interface OAuthForm { tokenUrl: string; clientId: string; scope: string; audience: string; clientAuth: 'basic' | 'post' }

export function toOAuthForm(oauth?: App['oauth']): OAuthForm {
  return {
    tokenUrl: oauth?.tokenUrl ?? '', clientId: oauth?.clientId ?? '', scope: oauth?.scope ?? '',
    audience: oauth?.audience ?? '', clientAuth: oauth?.clientAuth ?? 'basic',
  }
}

export function fromOAuthForm(form: OAuthForm): NonNullable<App['oauth']> {
  return {
    tokenUrl: form.tokenUrl.trim(), clientId: form.clientId.trim(), clientAuth: form.clientAuth,
    ...(form.scope.trim() ? { scope: form.scope.trim() } : {}),
    ...(form.audience.trim() ? { audience: form.audience.trim() } : {}),
  }
}

/** Token URL, client ID, scope, audience and client authentication for OAuth client credentials. */
export function OAuthFields({ value, onChange, inputClass }: { value: OAuthForm; onChange: (v: OAuthForm) => void; inputClass: string }) {
  const set = (field: keyof OAuthForm, v: string) => onChange({ ...value, [field]: v })
  const label = 'block text-xs font-medium text-gray-400 mb-1'
  return (
    <div className="space-y-3">
      <label className="block">
        <span className={label}>Token URL</span>
        <input type="url" required value={value.tokenUrl} onChange={e => set('tokenUrl', e.target.value)} placeholder="https://auth.example.com/oauth/token" className={inputClass} />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={label}>Client ID</span>
          <input required value={value.clientId} onChange={e => set('clientId', e.target.value)} autoComplete="off" className={`${inputClass} font-mono`} />
        </label>
        <label className="block">
          <span className={label}>Send client secret as</span>
          <select value={value.clientAuth} onChange={e => set('clientAuth', e.target.value)} className={inputClass}>
            <option value="basic">HTTP Basic header</option>
            <option value="post">Form body</option>
          </select>
        </label>
        <label className="block">
          <span className={label}>Scope <span className="text-gray-600">(optional)</span></span>
          <input value={value.scope} onChange={e => set('scope', e.target.value)} placeholder="read:orders" className={inputClass} />
        </label>
        <label className="block">
          <span className={label}>Audience <span className="text-gray-600">(optional)</span></span>
          <input value={value.audience} onChange={e => set('audience', e.target.value)} placeholder="https://api.example.com" className={inputClass} />
        </label>
      </div>
    </div>
  )
}
