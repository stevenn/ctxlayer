import pc from 'picocolors'
import { CtxlayerError } from '../errors'
import { loadCredentials } from '../auth/token-store'
import { refreshIfNeeded } from '../auth/client'

/**
 * Print local credential summary. Useful for "is the CLI talking to
 * the right install" and "when does my token expire". Does NOT hit
 * the network beyond a refresh attempt if the access token is close
 * to expiry.
 */
export async function whoamiCommand(): Promise<void> {
  const initial = await loadCredentials()
  if (!initial) {
    throw new CtxlayerError(
      'Not logged in. Run `ctxlayer login --base-url <https://...>` first.',
      'not_logged_in'
    )
  }
  const creds = await refreshIfNeeded(initial)
  const now = Math.floor(Date.now() / 1000)
  const remaining = creds.expiresAt - now
  console.log(pc.bold('Base URL:'), creds.baseUrl)
  console.log(pc.bold('Client:  '), creds.clientId)
  if (creds.userEmail) console.log(pc.bold('Email:   '), creds.userEmail)
  console.log(
    pc.bold('Token:   '),
    remaining > 0
      ? `expires in ${humanDuration(remaining)}`
      : pc.yellow('expired — will refresh on next request')
  )
}

function humanDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}
