import type { McpServer } from '@modelcontextprotocol/server'
import { builtinToolMeta } from '@ctxlayer/shared'
import { z } from 'zod'
import type { RecordBuiltin } from './recorder'
import type { BuiltinCall, BuiltinResult, BuiltinTool } from './types'

type WireResult = Omit<BuiltinResult, 'usageResp'>

/**
 * Register lane-neutral built-ins on an MCP SDK v2 server (the stateless
 * lane). The twin of `register-v1.ts`.
 *
 * v2 takes a schema object rather than a raw shape, and its callback is
 * always `(args, ctx)` once an input schema is given — so every tool gets
 * one, an empty object for the tools that take no arguments.
 */
export function registerBuiltinsV2(
  server: McpServer,
  tools: readonly BuiltinTool[],
  call: () => BuiltinCall,
  rec: RecordBuiltin,
  // Called with the SDK's per-call context before the tool runs — the
  // stateless lane reads the client's identity from it for usage.
  onCall?: (ctx: unknown) => void
): void {
  // As in the v1 adapter: definitions with erased argument types cannot
  // satisfy the SDK's generic `registerTool` statically; the SDK validates
  // args against `inputSchema` at runtime regardless.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    cb: (args: unknown, ctx: unknown) => Promise<WireResult>
  ) => unknown

  for (const tool of tools) {
    register(
      tool.name,
      {
        ...builtinToolMeta(tool.name),
        inputSchema: z.object(tool.inputShape ?? {}),
        ...(tool.outputShape ? { outputSchema: z.object(tool.outputShape) } : {})
      },
      (args, ctx) => {
        onCall?.(ctx)
        // Recorded with no args for a no-argument tool, as on the session lane.
        const recordedArgs = tool.inputShape ? args : undefined
        let usageResp: string | undefined
        return rec(
          tool.name,
          recordedArgs,
          async () => {
            const { usageResp: counted, ...wire } = await tool.run(args, call())
            usageResp = counted
            return wire
          },
          { usageResp: () => usageResp }
        )
      }
    )
  }
}
