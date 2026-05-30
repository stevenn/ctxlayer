/**
 * Nightly prune of abandoned DCR client registrations.
 *
 * MCP hosts that use RFC 8252 §7.3 loopback redirects (Claude Code,
 * Cursor, Windsurf, …) do a fresh Dynamic Client Registration per auth
 * attempt — each mints a new public `client_id` on an ephemeral
 * `http://localhost:<port>/callback`. Attempts that are retried,
 * cancelled, or superseded leave behind a registration with no grant.
 * `workers-oauth-provider` never expires client records, so without a
 * sweep these accumulate forever and clutter the admin viewer.
 *
 * Policy (see `isPrunableClient`): delete a client iff it is PUBLIC
 * (token_endpoint_auth_method='none'), has ZERO grants, and was
 * registered more than `olderThanDays` ago. Confidential clients
 * (stable hosted redirects, e.g. claude.ai) are never auto-pruned even
 * with zero grants — a missing grant there reads as "not used yet",
 * not "abandoned".
 *
 * Fail-closed: if the grant index is incomplete (a per-user
 * listUserGrants read failed, so a real grant could be invisible) we
 * delete NOTHING this run and report it. A legitimate client must never
 * be deleted because a transient KV read made it look orphaned.
 */

import type { Env } from '../env'
import { buildUserGrantIndex, type OAuthHelpers } from './client-grants'

const SECONDS_PER_DAY = 86400

export interface PruneClientsResult {
  scanned: number
  /** Clients matching the prune policy. */
  orphans: number
  deleted: number
  /** deleteClient calls that threw. */
  failed: number
  /** True when we declined to delete because the grant index undercounts. */
  skippedIncompleteIndex: boolean
  deletedIds: string[]
}

/** Minimal shape of a client record needed to decide prunability. */
interface ClientLike {
  clientId: string
  tokenEndpointAuthMethod: string
  registrationDate?: number | null
}

/**
 * Pure prune predicate. `grantIndex` keys are clients that hold ≥1
 * grant; absence ⇒ zero grants. `cutoffSeconds` is the youngest
 * registration timestamp we'll still delete (older = prunable).
 */
export function isPrunableClient(
  client: ClientLike,
  grantIndex: ReadonlyMap<string, unknown>,
  cutoffSeconds: number
): boolean {
  if (client.tokenEndpointAuthMethod !== 'none') return false // confidential
  if (grantIndex.has(client.clientId)) return false // has grants
  // No registrationDate ⇒ can't age it ⇒ keep (don't delete blind).
  if (typeof client.registrationDate !== 'number') return false
  return client.registrationDate < cutoffSeconds
}

/**
 * Core loop, decoupled from the grant-index build so it's unit-testable
 * with a mock helpers + a plain Map. Paginates all clients and deletes
 * the prunable ones best-effort.
 */
export async function pruneClientsByPolicy(
  helpers: Pick<OAuthHelpers, 'listClients' | 'deleteClient'>,
  grantIndex: ReadonlyMap<string, unknown>,
  cutoffSeconds: number
): Promise<Omit<PruneClientsResult, 'skippedIncompleteIndex'>> {
  let scanned = 0
  let orphans = 0
  let deleted = 0
  let failed = 0
  const deletedIds: string[] = []

  let cursor: string | undefined
  let pages = 0
  do {
    const page = await helpers.listClients({ limit: 200, cursor })
    for (const client of page.items) {
      scanned++
      if (!isPrunableClient(client, grantIndex, cutoffSeconds)) continue
      orphans++
      try {
        await helpers.deleteClient(client.clientId)
        deleted++
        deletedIds.push(client.clientId)
      } catch (err) {
        failed++
        console.warn(
          `[prune-clients] deleteClient(${client.clientId}) failed:`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
    cursor = page.cursor
    // Safety backstop against an ill-behaved cursor — 50×200 = 10k
    // clients, far beyond any realistic registration count.
    if (++pages > 50) {
      console.warn('[prune-clients] stopped after 50 pages; cursor may be looping')
      break
    }
  } while (cursor)

  return { scanned, orphans, deleted, failed, deletedIds }
}

export async function pruneOrphanOAuthClients(
  env: Env,
  helpers: OAuthHelpers,
  opts: { olderThanDays: number; now?: number }
): Promise<PruneClientsResult> {
  const nowSeconds = opts.now ?? Math.floor(Date.now() / 1000)
  const cutoff = nowSeconds - opts.olderThanDays * SECONDS_PER_DAY

  const { index, complete } = await buildUserGrantIndex(env, helpers)
  if (!complete) {
    return {
      scanned: 0,
      orphans: 0,
      deleted: 0,
      failed: 0,
      skippedIncompleteIndex: true,
      deletedIds: []
    }
  }

  const core = await pruneClientsByPolicy(helpers, index, cutoff)
  return { ...core, skippedIncompleteIndex: false }
}
