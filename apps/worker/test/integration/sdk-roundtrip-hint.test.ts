import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

/**
 * Pins the layer the registry-level hint tests cannot see: the MCP SDK's
 * own tools/call pipeline. The 2026-08-27 field tests showed the
 * first-result hint missing on fresh sessions even though the handler
 * provably appends it — this test asks whether a two-item content array
 * (payload + ⟦ctxlayer⟧ hint) plus structuredContent survives an actual
 * SDK server→client round trip for a tool registered WITHOUT an
 * outputSchema (exactly how the proxy registers upstream tools).
 */

const PAYLOAD = '{"payload":["lucy-a"],"error_message":null}'
const HINT = '⟦ctxlayer⟧ Org playbooks exist for `up-driver`: skill `sk-x` ("X") ⟦/ctxlayer⟧'

async function roundTrip(result: Record<string, unknown>) {
  const server = new McpServer({ name: 't', version: '0.0.0' })
  ;(
    server.registerTool as unknown as (
      name: string,
      cfg: { title: string; description: string; inputSchema: unknown },
      cb: () => unknown
    ) => unknown
  )(
    'up-driver__get_codebase_names',
    { title: 'up-driver__get_codebase_names', description: 'd', inputSchema: {} },
    async () => result
  )
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'c', version: '0.0.0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client.callTool({ name: 'up-driver__get_codebase_names', arguments: {} })
}

describe('MCP SDK tools/call round-trip', () => {
  it('preserves a two-item content array WITHOUT structuredContent', async () => {
    const res = await roundTrip({
      isError: false,
      content: [
        { type: 'text', text: PAYLOAD },
        { type: 'text', text: HINT }
      ]
    })
    expect(res.isError ?? false).toBe(false)
    const content = res.content as Array<{ type: string; text?: string }>
    expect(content).toHaveLength(2)
    expect(content[1]!.text).toBe(HINT)
  })

  it('preserves a two-item content array WITH structuredContent (no outputSchema declared)', async () => {
    const res = await roundTrip({
      isError: false,
      content: [
        { type: 'text', text: PAYLOAD },
        { type: 'text', text: HINT }
      ],
      structuredContent: { payload: ['lucy-a'], error_message: null }
    })
    expect(res.isError ?? false).toBe(false)
    const content = res.content as Array<{ type: string; text?: string }>
    expect(content).toHaveLength(2)
    expect(content[1]!.text).toBe(HINT)
    expect(res.structuredContent).toEqual({ payload: ['lucy-a'], error_message: null })
  })
})
