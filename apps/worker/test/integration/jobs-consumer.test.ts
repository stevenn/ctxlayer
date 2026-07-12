import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { runJob } from '../../src/queues/jobs-consumer'
import { findJobById, insertRunningJob } from '../../src/db/queries/async-jobs'
import type { UpstreamCallResult, UpstreamClient } from '../../src/upstream/upstream-client'
import type { UpstreamConnection } from '../../src/db/queries/upstreams'

/**
 * Real-D1 cover for the background job runner. `runJob` takes an injected
 * client factory so we exercise the persist paths (done / terminal error /
 * upstream-gone / idempotent redelivery) without a live upstream. The
 * integration env binds no USAGE_QUEUE — the runner's usage send is
 * best-effort, so a done job is still stored.
 */
const testEnv = env as unknown as Env

async function seedUpstream(id: string, slug: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO upstream_servers
       (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
     VALUES (?1, ?2, ?2, 'streamable_http', 'https://x.test/mcp', 'none', '{}', 0, 0)`
  )
    .bind(id, slug)
    .run()
}

function fakeClient(
  call: UpstreamCallResult | (() => Promise<UpstreamCallResult>)
): (conn: UpstreamConnection, bearer: string | null) => UpstreamClient {
  return () => ({
    listTools: async () => [],
    callTool: async () => (typeof call === 'function' ? call() : call),
    close: async () => {}
  })
}

const msg = (over: Record<string, unknown> = {}) => ({
  jobId: 'j',
  userId: 'u1',
  upstreamId: 'ups',
  tool: 'gather_task_context',
  argsJson: '{}',
  sessionId: 's',
  ...over
})

describe('jobs-consumer runJob', () => {
  it('stores a successful result as a done job', async () => {
    await seedUpstream('ups-ok', 'up-ok')
    await insertRunningJob(testEnv, {
      id: 'jok',
      userId: 'u1',
      sessionId: 's',
      upstreamId: 'ups-ok',
      tool: 'gather_task_context',
      jobKey: 'kok',
      createdAt: 1
    })
    await runJob(
      testEnv,
      msg({ jobId: 'jok', upstreamId: 'ups-ok' }),
      fakeClient({ content: [{ type: 'text', text: 'the answer' }] })
    )
    const done = await findJobById(testEnv, 'jok')
    expect(done?.status).toBe('done')
    expect(done?.result_json).toContain('the answer')
  })

  it('stores a thrown timeout as a terminal error job', async () => {
    await seedUpstream('ups-err', 'up-err')
    await insertRunningJob(testEnv, {
      id: 'jerr',
      userId: 'u1',
      sessionId: 's',
      upstreamId: 'ups-err',
      tool: 't',
      jobKey: 'kerr',
      createdAt: 1
    })
    await runJob(
      testEnv,
      msg({ jobId: 'jerr', upstreamId: 'ups-err', tool: 't' }),
      fakeClient(async () => {
        throw new Error('Request timed out')
      })
    )
    const err = await findJobById(testEnv, 'jerr')
    expect(err?.status).toBe('error')
    // Coarse usage class is 'timeout'; the stored detail is the sanitised
    // agent-facing message (`upstream_timeout: … (ref=…)`).
    expect(err?.error_code).toBe('timeout')
    expect(err?.error_detail).toContain('upstream_timeout')
  })

  it('errors cleanly when the upstream is gone', async () => {
    await insertRunningJob(testEnv, {
      id: 'jgone',
      userId: 'u1',
      sessionId: 's',
      upstreamId: 'nope',
      tool: 't',
      jobKey: 'kgone',
      createdAt: 1
    })
    await runJob(testEnv, msg({ jobId: 'jgone', upstreamId: 'nope', tool: 't' }), fakeClient({ content: [] }))
    const gone = await findJobById(testEnv, 'jgone')
    expect(gone?.status).toBe('error')
    expect(gone?.error_code).toBe('upstream_gone')
  })

  it('is a no-op for an already-completed job (idempotent redelivery)', async () => {
    await seedUpstream('ups-dup', 'up-dup')
    await insertRunningJob(testEnv, {
      id: 'jdup',
      userId: 'u1',
      sessionId: 's',
      upstreamId: 'ups-dup',
      tool: 't',
      jobKey: 'kdup',
      createdAt: 1
    })
    await runJob(
      testEnv,
      msg({ jobId: 'jdup', upstreamId: 'ups-dup', tool: 't' }),
      fakeClient({ content: [{ type: 'text', text: 'first' }] })
    )
    // Redeliver with a DIFFERENT result — must not overwrite the completed job.
    await runJob(
      testEnv,
      msg({ jobId: 'jdup', upstreamId: 'ups-dup', tool: 't' }),
      fakeClient({ content: [{ type: 'text', text: 'second' }] })
    )
    const job = await findJobById(testEnv, 'jdup')
    expect(job?.result_json).toContain('first')
    expect(job?.result_json).not.toContain('second')
  })
})
