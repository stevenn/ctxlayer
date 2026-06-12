/**
 * Best-effort operator alerting.
 *
 * The worker's failure paths (cron tasks, queue consumers, poison messages)
 * previously only `console.error`'d — invisible unless someone tails the
 * logs. `notify()` POSTs a compact JSON to `ALERT_WEBHOOK_URL` when
 * configured, so a Slack/Discord/generic incoming webhook surfaces the
 * failure. Slack reads `text`; structured collectors read the typed fields.
 *
 * Contract: NEVER throws (alerting must not break the path it observes),
 * no-ops when the binding is unset, and is bounded by a short timeout so a
 * slow webhook can't stall a cron/queue handler. Keep `detail` free of
 * secrets — the payload may be archived by the webhook target.
 */

import type { Env } from '../env'

export type AlertLevel = 'error' | 'warn'

export interface AlertInput {
  /** Severity — drives the emoji + lets the collector filter. */
  level: AlertLevel
  /** Dotted machine code, e.g. `cron.git_sync_failed`, `reindex.poison`. */
  event: string
  /** Short human detail. NO secrets, tokens, or response bodies. */
  detail?: string
}

/** Human one-liner + structured fields. Pure, so it's unit-testable. */
export function buildAlertPayload(env: Env, input: AlertInput) {
  const sha = env.GIT_SHA || 'dev'
  const host = safeHost(env.PUBLIC_BASE_URL)
  const emoji = input.level === 'error' ? '🔴' : '🟠'
  const text =
    `${emoji} ctxlayer ${host} [${sha}] ${input.event}` +
    (input.detail ? `: ${input.detail}` : '')
  return { text, level: input.level, event: input.event, detail: input.detail, host, sha }
}

export async function notify(
  env: Env,
  input: AlertInput,
  // Injectable for tests; defaults to the global fetch in production.
  doFetch: typeof fetch = fetch
): Promise<void> {
  const url = env.ALERT_WEBHOOK_URL
  if (!url) return
  try {
    await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...buildAlertPayload(env, input), ts: new Date().toISOString() }),
      signal: AbortSignal.timeout(4000)
    })
  } catch (err) {
    // Best-effort: a webhook failure must not propagate into the caller.
    console.error(`[alert] notify(${input.event}) failed:`, err instanceof Error ? err.message : err)
  }
}

function safeHost(base: string | undefined): string {
  try {
    return base ? new URL(base).host : 'unknown'
  } catch {
    return 'unknown'
  }
}
