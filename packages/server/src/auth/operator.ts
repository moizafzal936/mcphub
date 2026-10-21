import { randomBytes } from 'crypto'
import { z } from 'zod'
import { newId, userRepo } from '../storage/db.js'
import { hashPassword } from '../security/passwords.js'

/**
 * Creates the operator (first) account from the server shell. Refuses once any account exists,
 * so it can't be used to add users later. Returns a generated password, shown once.
 */
export async function createOperatorAccount(rawEmail: string): Promise<{ email: string; password: string }> {
  const email = z.string().trim().toLowerCase().email().max(254).parse(rawEmail)
  const password = randomBytes(18).toString('base64url')
  const user = { id: newId(), email, createdAt: Date.now(), passwordHash: await hashPassword(password) }
  if (!(await userRepo.insertIf(user, true))) throw new Error('An account already exists; the operator was created earlier')
  return { email, password }
}
