// RFC 9110 field-name = token
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// RFC 9110 field-value: visible chars, SP, HTAB and obs-text. No CR, LF, NUL or other controls.
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

export const MAX_HEADER_VALUE_LENGTH = 8 * 1024

// Headers a tool parameter may never set: transport-level and proxy headers, and anything that
// could replace the app's configured credential.
const RESERVED = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te',
  'trailer', 'expect', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
  'authorization', 'cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-real-ip', 'content-type', 'accept',
])

export function isValidHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= 256 && TOKEN.test(name)
}

export function isValidHeaderValue(value: string): boolean {
  return value.length <= MAX_HEADER_VALUE_LENGTH && FIELD_VALUE.test(value)
}

export function isReservedHeader(name: string, credentialHeader?: string): boolean {
  const lower = name.toLowerCase()
  return RESERVED.has(lower) || lower.startsWith('sec-') || (!!credentialHeader && lower === credentialHeader.toLowerCase())
}

/** Header name usable as the app's credential header (e.g. Authorization, X-API-Key). */
export function isValidCredentialHeader(name: string): boolean {
  if (!isValidHeaderName(name)) return false
  const lower = name.toLowerCase()
  return lower === 'authorization' || !RESERVED.has(lower)
}
