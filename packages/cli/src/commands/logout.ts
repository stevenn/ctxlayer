import pc from 'picocolors'
import { deleteCredentials, loadCredentials } from '../auth/token-store'

export async function logoutCommand(): Promise<void> {
  const existing = await loadCredentials()
  if (!existing) {
    console.log('Not logged in. Nothing to do.')
    return
  }
  await deleteCredentials()
  console.log(pc.green('✓'), 'Logged out. Credentials file removed.')
}
