const SENSITIVE_KEY_PARTS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'authorization', 'cookie',
  'sessionid', 'credential', 'privatekey', 'accesskey', 'clientsecret', 'signature', 'ssn',
  'cardnumber', 'creditcard', 'cvv', 'cvc', 'iban', 'otp',
]
const SENSITIVE_KEY_EXACT = new Set(['auth', 'pwd', 'pin', 'key', 'session', 'bearer'])

const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, // Stripe-style keys
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bmcph_[A-Za-z0-9_-]{20,}\b/g,
]

export const REDACTED = '[REDACTED]'

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SENSITIVE_KEY_EXACT.has(k) || SENSITIVE_KEY_PARTS.some(p => k.includes(p))
}

export function redactString(value: string, knownSecrets: string[] = []): string {
  let out = value
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join(REDACTED)
  }
  for (const re of SENSITIVE_VALUE_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

export function redact(value: unknown, knownSecrets: string[] = [], depth = 0): unknown {
  if (depth > 20) return '[TRUNCATED]'
  if (typeof value === 'string') return redactString(value, knownSecrets)
  if (Array.isArray(value)) return value.map(v => redact(v, knownSecrets, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redact(v, knownSecrets, depth + 1)
    }
    return out
  }
  return value
}

/** Redact, then bound the stored size of a log payload. */
export function redactForLog(value: unknown, knownSecrets: string[], maxChars = 16 * 1024): unknown {
  const clean = redact(value, knownSecrets)
  const text = JSON.stringify(clean) ?? 'null'
  if (text.length <= maxChars) return clean
  return { truncated: true, originalChars: text.length, preview: text.slice(0, maxChars) }
}
