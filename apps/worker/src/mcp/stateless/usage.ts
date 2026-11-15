import type { Env } from '../../env'
import { buildUsageMsg, type RecordUsageArgs } from '../../usage/record'
import { errMessage } from '../../util/errors'

/**
 * Usage recording for the stateless lane.
 *
 * There is no Durable Object here, so no SQLite outbox: the usage event goes
 * straight to `USAGE_QUEUE`, awaited on the tool path. (The session lane's
 * outbox exists because a `waitUntil` send was cancelled when its streamed
 * response ended; an awaited send has no such window, and the async-jobs
 * consumer has always recorded this way.) Never throws into the tool path — a
 * lost usage row must never break a working tool call.
 */
export async function sendUsage(env: Env, args: RecordUsageArgs): Promise<void> {
  try {
    await env.USAGE_QUEUE.send(buildUsageMsg(args))
  } catch (err) {
    console.error(`[usage] send failed for ${args.tool}: ${errMessage(err)}`)
  }
}

/**
 * The stateless lane's stand-in for a session id: a short, stable hash of
 * (user, OAuth client). It fills `usage_events.session_id` and keys the
 * first-result hint ledger, so one person's different clients are told
 * apart without anything client-supplied being stored.
 */
export async function sessionKeyFor(userId: string, clientId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${userId}:${clientId}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
  return `sl-${hex}`
}
