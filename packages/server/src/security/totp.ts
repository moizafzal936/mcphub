import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

// RFC 6238 TOTP: HMAC-SHA1, 30 s steps, 6 digits (what Google Authenticator, 1Password, Authy use).
const STEP_SECONDS = 30
const DIGITS = 6
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error('Invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS
  return bin.toString().padStart(DIGITS, '0')
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS)
}

/** Returns the matched time step (±1 step of clock drift), or undefined. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined
  const step = currentStep(now)
  for (const s of [step - 1, step, step + 1]) {
    const expected = Buffer.from(totpCode(secret, s))
    if (timingSafeEqual(expected, Buffer.from(code))) return s
  }
  return undefined
}

export function otpauthUrl(secret: string, account: string): string {
  const label = encodeURIComponent(`MCPHub:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=MCPHub&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
}
