import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { BUILTIN_TOOLS } from '@ctxlayer/shared'
import type { Env as WorkerEnv, McpProps } from '../../src/env'
import { RELOAD_UPSTREAMS_POSITION, SHARED_BUILTINS } from '../../src/mcp/builtins'
import { registerBuiltinsV1 } from '../../src/mcp/builtins/register-v1'
import type { RecordBuiltin } from '../../src/mcp/builtins/recorder'
import { completeJobDone, insertRunningJob } from '../../src/db/queries/async-jobs'

/**
 * The lane-neutral built-in definitions (`mcp/builtins/`) and the session
 * lane's SDK v1 adapter, driven through a real MCP SDK server↔client pair
 * against real D1 — the first tests that exercise built-in tools end to end
 * (the Durable Object that hosts them cannot be constructed under vitest).
 */

const testEnv = env as unknown as WorkerEnv

const ALICE: McpProps = { userId: 'u-alice', email: 'alice@example.test', role: 'user' }
const ADMIN: McpProps = { userId: 'u-admin', email: 'admin@example.test', role: 'admin' }

interface Recorded {
  tool: string
  args: unknown
  counted: string | undefined
  isError: boolean
}

/** A connected client over the shared built-ins, plus what `rec` saw. */
async function connect(user: McpProps | undefined) {
  const recorded: Recorded[] = []
  const rec: RecordBuiltin = async (tool, args, exec, opts) => {
    const result = await exec()
    recorded.push({
      tool,
      args,
      counted: opts?.usageResp?.(result),
      isError: result.isError === true
    })
    return result
  }
  const server = new McpServer({ name: 't', version: '0.0.0' })
  registerBuiltinsV1(server, SHARED_BUILTINS, () => ({ env: testEnv, user }), rec)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'c', version: '0.0.0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return { client, recorded }
}

const textOf = (res: unknown) =>
  ((res as { content: Array<{ type: string; text: string }> }).content)
    .map((c) => c.text)
    .join('\n')

describe('built-in catalogue', () => {
  it('shared definitions + reload_upstreams are exactly the catalogued built-ins', () => {
    const defined = [...SHARED_BUILTINS.map((t) => t.name), 'reload_upstreams'].sort()
    expect(defined).toEqual(BUILTIN_TOOLS.map((t) => t.name).sort())
  })

  it('keeps the tools/list order agents have always seen', () => {
    const names = SHARED_BUILTINS.map((t) => t.name)
    names.splice(RELOAD_UPSTREAMS_POSITION, 0, 'reload_upstreams')
    expect(names).toEqual([
      'whoami',
      'list_my_context',
      'list_upstreams',
      'describe_upstream',
      'reload_upstreams',
      'get_doc',
      'search_docs',
      'active_users',
      'poll_task',
      'list_tasks',
      'list_skills',
      'get_skill',
      'draft_skill',
      'save_draft_skill'
    ])
  })
})

describe('registerBuiltinsV1', () => {
  it('lists every shared built-in with its catalogued description and schema', async () => {
    const { client } = await connect(ALICE)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(SHARED_BUILTINS.map((t) => t.name))
    for (const tool of tools) {
      const meta = BUILTIN_TOOLS.find((b) => b.name === tool.name)
      expect(tool.description).toBe(meta?.description)
    }
    const getDoc = tools.find((t) => t.name === 'get_doc')
    expect(getDoc?.inputSchema.required).toEqual(['id'])
    // A no-argument tool still advertises an (empty) object schema.
    expect(tools.find((t) => t.name === 'whoami')?.inputSchema.type).toBe('object')
  })

  it('a no-argument tool runs, and is recorded with no args', async () => {
    const { client, recorded } = await connect(ALICE)
    const res = await client.callTool({ name: 'whoami', arguments: {} })
    expect(JSON.parse(textOf(res))).toEqual(ALICE)
    expect(recorded).toEqual([
      { tool: 'whoami', args: undefined, counted: undefined, isError: false }
    ])
  })

  it('a tool with arguments receives them validated, and a failure is recorded as one', async () => {
    const { client, recorded } = await connect(ALICE)
    const res = await client.callTool({ name: 'get_doc', arguments: { id: 'no-such-doc' } })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe('doc not found: no-such-doc')
    expect(recorded).toEqual([
      { tool: 'get_doc', args: { id: 'no-such-doc' }, counted: undefined, isError: true }
    ])

    // Arguments that fail the schema never reach the handler (or the recorder).
    const bad = await client.callTool({ name: 'get_doc', arguments: {} })
    expect(bad.isError).toBe(true)
    expect(recorded).toHaveLength(1)
  })

  it('refuses identity-bound tools when the request carries no user', async () => {
    const { client } = await connect(undefined)
    for (const name of ['list_my_context', 'list_upstreams', 'list_tasks']) {
      const res = await client.callTool({ name, arguments: {} })
      expect(textOf(res)).toBe('not_signed_in')
    }
  })

  it('active_users returns data to admins only', async () => {
    const member = await connect(ALICE)
    const denied = await member.client.callTool({ name: 'active_users', arguments: {} })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toBe('admin_only')

    const admin = await connect(ADMIN)
    const ok = await admin.client.callTool({ name: 'active_users', arguments: {} })
    expect(ok.isError ?? false).toBe(false)
    expect(ok.structuredContent).toMatchObject({ activeUserCount: 0, users: [] })
  })
})

describe('poll_task / list_tasks', () => {
  const now = Math.floor(Date.now() / 1000)
  const job = (id: string, userId: string) => ({
    id,
    userId,
    sessionId: 's',
    upstreamId: 'ups-x',
    tool: 'slow_tool',
    jobKey: `k-${id}`,
    createdAt: now - 5
  })

  it("another user's job is indistinguishable from a missing one", async () => {
    await insertRunningJob(testEnv, job('job-bob', 'u-bob'))
    const { client } = await connect(ALICE)
    const theirs = await client.callTool({ name: 'poll_task', arguments: { job_id: 'job-bob' } })
    const missing = await client.callTool({ name: 'poll_task', arguments: { job_id: 'job-nope' } })
    expect(textOf(theirs)).toBe('not_found: no such job')
    expect(textOf(theirs)).toBe(textOf(missing))

    const list = await client.callTool({ name: 'list_tasks', arguments: {} })
    expect(JSON.parse(textOf(list))).toEqual([])
  })

  it('reports a running job, then replays the stored result and bills only the delivery', async () => {
    await insertRunningJob(testEnv, job('job-a', 'u-alice'))
    const { client, recorded } = await connect(ALICE)

    const running = await client.callTool({ name: 'poll_task', arguments: { job_id: 'job-a' } })
    expect(textOf(running)).toMatch(/^still_running: job job-a/)

    await completeJobDone(
      testEnv,
      'job-a',
      JSON.stringify([{ type: 'text', text: 'the big upstream payload' }]),
      now
    )
    const done = await client.callTool({ name: 'poll_task', arguments: { job_id: 'job-a' } })
    expect(textOf(done)).toBe('the big upstream payload')
    // The non-wire usage override never reaches the agent…
    expect(done).not.toHaveProperty('usageResp')
    // …but the recorder counts the marker instead of the payload.
    expect(recorded[0]?.counted).toBeUndefined()
    expect(recorded[1]?.counted).toMatch(/^delivered: 'slow_tool' result replayed/)

    const list = await client.callTool({ name: 'list_tasks', arguments: {} })
    expect(JSON.parse(textOf(list))).toMatchObject([
      { job_id: 'job-a', tool: 'slow_tool', status: 'done' }
    ])
  })
})
