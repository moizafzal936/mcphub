import { initialize } from '../app.js'
import { appRepo, closeDb, userRepo } from '../storage/db.js'

const email = process.argv[2]?.trim().toLowerCase()
if (!email) {
  console.error('Usage: npm run assign-orphans -w packages/server -- <user-email>')
  process.exit(1)
}

await initialize()
const user = await userRepo.findByEmail(email)
if (!user) {
  console.error(`No user with email ${email}. Register in the dashboard first.`)
  closeDb()
  process.exit(1)
}
const n = await appRepo.assignOrphansTo(user.id)
console.log(`Assigned ${n} ownerless app(s) to ${email}`)
closeDb()
