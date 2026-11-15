import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { builtinToolMeta } from '@ctxlayer/shared'
import type { RecordBuiltin } from './recorder'
import type { BuiltinCall, BuiltinResult, BuiltinTool } from './types'

type WireResult = Omit<BuiltinResult, 'usageResp'>

/**
 * Register lane-neutral built-ins on an MCP SDK v1 server (the session lane).
 *
 * The v1 `registerTool` callback is `(args, extra)` when the tool declares an
 * input schema and `(extra)` when it does not, so the two cases are wired
 * separately rather than reading a first argument that may be `extra`.
 */
export function registerBuiltinsV1(
  server: McpServer,
  tools: readonly BuiltinTool[],
  call: () => BuiltinCall,
  rec: RecordBuiltin
): void {
  // The SDK's `registerTool` is generic over the schema it is handed; a list
  // of definitions with erased argument types cannot satisfy that statically,
  // and the SDK validates args against `inputSchema` at runtime regardless.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    cb: (...a: unknown[]) => Promise<WireResult>
  ) => unknown

  for (const tool of tools) {
    const run = (args: unknown): Promise<WireResult> => {
      let usageResp: string | undefined
      return rec(
        tool.name,
        args,
        async () => {
          const { usageResp: counted, ...wire } = await tool.run(args, call())
          usageResp = counted
          return wire
        },
        { usageResp: () => usageResp }
      )
    }
    const config = {
      ...builtinToolMeta(tool.name),
      ...(tool.inputShape ? { inputSchema: tool.inputShape } : {}),
      ...(tool.outputShape ? { outputSchema: tool.outputShape } : {})
    }
    if (tool.inputShape) register(tool.name, config, (args) => run(args))
    else register(tool.name, config, () => run(undefined))
  }
}
