/**
 * Unit tests for the orphan-client prune policy + loop. The grant-index
 * build (KV + D1) is mocked; we exercise the pure predicate, the
 * paginating delete loop with a fake helpers, and the fail-closed guard.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./client-grants', () => ({ buildUserGrantIndex: vi.fn() }))
import { buildUserGrantIndex } from './client-grants'
import { isPrunableClient, pruneClientsByPolicy, pruneOrphanOAuthClients } from './prune-clients'

const DAY = 86400
const NOW = 1_780_000_000
const CUTOFF = NOW - DAY // registered before this ⇒ old enough to prune

function client(over: Partial<Parameters<typeof isPrunableClient>[0]> = {}) {
  return {
    clientId: 'c1',
    tokenEndpointAuthMethod: 'none',
    registrationDate: NOW - 2 * DAY, // 2 days old by default
    ...over
  }
}

const noGrants = new Map<string, unknown>()

describe('isPrunableClient', () => {
  it('prunes a public, grant-less, old client', () => {
    expect(isPrunableClient(client(), noGrants, CUTOFF)).toBe(true)
  })

  it('keeps confidential clients even when grant-less and old', () => {
    expect(
      isPrunableClient(client({ tokenEndpointAuthMethod: 'client_secret_basic' }), noGrants, CUTOFF)
    ).toBe(false)
  })

  it('keeps clients that have grants', () => {
    const grants = new Map<string, unknown>([['c1', [{}]]])
    expect(isPrunableClient(client(), grants, CUTOFF)).toBe(false)
  })

  it('keeps clients younger than the cutoff', () => {
    expect(isPrunableClient(client({ registrationDate: NOW - 60 }), noGrants, CUTOFF)).toBe(false)
  })

  it('keeps clients with no registrationDate (cannot be aged)', () => {
    expect(isPrunableClient(client({ registrationDate: null }), noGrants, CUTOFF)).toBe(false)
    expect(isPrunableClient(client({ registrationDate: undefined }), noGrants, CUTOFF)).toBe(false)
  })
})

interface FakeClient {
  clientId: string
  tokenEndpointAuthMethod: string
  registrationDate?: number | null
}

function makeHelpers(clients: FakeClient[], throwOn: string[] = []) {
  const deleted: string[] = []
  return {
    deleted,
    helpers: {
      // Paginate in pages of 2 so we exercise the cursor loop.
      listClients: vi.fn(async ({ cursor }: { limit?: number; cursor?: string }) => {
        const start = cursor ? Number(cursor) : 0
        const items = clients.slice(start, start + 2)
        const next = start + 2
        return { items, cursor: next < clients.length ? String(next) : undefined }
      }),
      deleteClient: vi.fn(async (id: string) => {
        if (throwOn.includes(id)) throw new Error('kv boom')
        deleted.push(id)
      })
    }
  }
}

describe('pruneClientsByPolicy', () => {
  it('deletes only prunable clients across pages', async () => {
    const clients: FakeClient[] = [
      { clientId: 'orphan-a', tokenEndpointAuthMethod: 'none', registrationDate: NOW - 2 * DAY },
      { clientId: 'has-grant', tokenEndpointAuthMethod: 'none', registrationDate: NOW - 2 * DAY },
      {
        clientId: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        registrationDate: NOW - 5 * DAY
      },
      { clientId: 'too-young', tokenEndpointAuthMethod: 'none', registrationDate: NOW - 60 },
      { clientId: 'orphan-b', tokenEndpointAuthMethod: 'none', registrationDate: NOW - 3 * DAY }
    ]
    const grants = new Map<string, unknown>([['has-grant', [{}]]])
    const { helpers, deleted } = makeHelpers(clients)

    const r = await pruneClientsByPolicy(helpers as never, grants, CUTOFF)

    expect(deleted.sort()).toEqual(['orphan-a', 'orphan-b'])
    expect(r.scanned).toBe(5)
    expect(r.orphans).toBe(2)
    expect(r.deleted).toBe(2)
    expect(r.failed).toBe(0)
    // 5 clients, pages of 2 ⇒ 3 listClients calls.
    expect(helpers.listClients).toHaveBeenCalledTimes(3)
  })

  it('counts deleteClient failures without aborting', async () => {
    const clients: FakeClient[] = [
      { clientId: 'orphan-a', tokenEndpointAuthMethod: 'none', registrationDate: NOW - 2 * DAY },
      { clientId: 'orphan-b', tokenEndpointAuthMethod: 'none', registrationDate: NOW - 2 * DAY }
    ]
    const { helpers, deleted } = makeHelpers(clients, ['orphan-a'])

    const r = await pruneClientsByPolicy(helpers as never, new Map(), CUTOFF)

    expect(r.orphans).toBe(2)
    expect(r.deleted).toBe(1)
    expect(r.failed).toBe(1)
    expect(deleted).toEqual(['orphan-b'])
  })
})

describe('pruneOrphanOAuthClients', () => {
  const env = {} as never

  it('fails closed when the grant index is incomplete', async () => {
    vi.mocked(buildUserGrantIndex).mockResolvedValueOnce({
      index: new Map(),
      complete: false
    })
    const { helpers, deleted } = makeHelpers([
      { clientId: 'orphan-a', tokenEndpointAuthMethod: 'none', registrationDate: NOW - 5 * DAY }
    ])

    const r = await pruneOrphanOAuthClients(env, helpers as never, {
      olderThanDays: 1,
      now: NOW
    })

    expect(r.skippedIncompleteIndex).toBe(true)
    expect(r.deleted).toBe(0)
    expect(deleted).toEqual([])
    expect(helpers.listClients).not.toHaveBeenCalled()
  })

  it('prunes when the index is complete', async () => {
    vi.mocked(buildUserGrantIndex).mockResolvedValueOnce({
      index: new Map(),
      complete: true
    })
    const { helpers, deleted } = makeHelpers([
      { clientId: 'orphan-a', tokenEndpointAuthMethod: 'none', registrationDate: NOW - 5 * DAY }
    ])

    const r = await pruneOrphanOAuthClients(env, helpers as never, {
      olderThanDays: 1,
      now: NOW
    })

    expect(r.skippedIncompleteIndex).toBe(false)
    expect(r.deleted).toBe(1)
    expect(deleted).toEqual(['orphan-a'])
  })
})
