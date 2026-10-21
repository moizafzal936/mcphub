import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'crypto'

// OWASP Password Storage Cheat Sheet minimum for scrypt: N=2^17, r=8, p=1.
const N = 2 ** 17
const R = 8
const P = 1
const KEYLEN = 32
const MAXMEM = 256 * 1024 * 1024

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, out) =>
      err ? reject(err) : resolve(out)
    )
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, N, R, P)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  const expected = Buffer.from(hashB64, 'base64url')
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), Number(n), Number(r), Number(p))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// Used when the account does not exist so login timing does not reveal registered emails.
let dummyHash: string | undefined
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= await hashPassword(randomBytes(16).toString('hex'))
  await verifyPassword(password, dummyHash)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
