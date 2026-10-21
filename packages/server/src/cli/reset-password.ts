import { randomBytes } from 'crypto'
import { initialize } from '../app.js'
import { closeDb, userRepo } from '../storage/db.js'
import { hashPassword } from '../security/passwords.js'

// Operator recovery: npm run reset-password -w packages/server -- <email> [--disable-2fa]
const email = process.argv[2]?.trim().toLowerCase()
const disable2fa = process.argv.includes('--disable-2fa')
if (!email || email.startsWith('--')) {
  console.error('Usage: npm run reset-password -w packages/server -- <email> [--disable-2fa]')
  process.exit(1)
}
try {
  await initialize()
  const user = await userRepo.findByEmail(email)
  if (!user) throw new Error(`No user with email ${email}`)
  const temporary = randomBytes(12).toString('base64url')
  await userRepo.resetPassword(user.id, await hashPassword(temporary))
  if (disable2fa) await userRepo.disableTotp(user.id)
  console.log(`Password reset for ${email}; all their sessions were signed out.${disable2fa ? ' Two-factor disabled.' : ''}`)
  console.log(`Temporary password (share securely, then have them change it): ${temporary}`)
} catch (err) {
  console.error('Reset failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  closeDb()
}
