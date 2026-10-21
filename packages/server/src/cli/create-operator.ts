import { initialize } from '../app.js'
import { closeDb } from '../storage/db.js'
import { createOperatorAccount } from '../auth/operator.js'

// First-run setup on a production server (web sign-up is closed until an account exists):
//   docker compose exec mcphub node packages/server/dist/cli/create-operator.js you@example.com
const email = process.argv[2]
if (!email) {
  console.error('Usage: create-operator <email>')
  process.exit(1)
}
try {
  await initialize()
  const account = await createOperatorAccount(email)
  console.log(`Operator account created for ${account.email}.`)
  console.log(`Password (shown once; store it in your password manager): ${account.password}`)
} catch (err) {
  console.error('Could not create the operator:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  closeDb()
}
