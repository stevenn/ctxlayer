/**
 * Lane-neutral built-in tool definitions.
 *
 * `/mcp` is served by two coexisting lanes — the session lane (`McpAgent`,
 * MCP SDK v1) and the stateless lane (MCP SDK v2). A built-in tool must
 * behave identically on both, so its schema and handler are written ONCE
 * here, against nothing lane-specific: no server instance, no session, no
 * Durable Object. Each lane registers the same definitions through its own
 * thin adapter (`register-v1.ts`, and the v2 twin in the stateless lane) and
 * supplies usage recording there.
 *
 * Title + description are not part of a definition: they stay in
 * `packages/shared/src/builtin-tools.ts` (`builtinToolMeta`), the single
 * source the agent surface and `/api/tools` share.
 */

import type { z } from 'zod'
import type { Env, McpProps } from '../../env'

/** What a built-in may know about the call: the deployment and the caller. */
export interface BuiltinCall {
  env: Env
  /** The signed-in user's props; undefined when the request carried none. */
  user: McpProps | undefined
}

/** A tool result in MCP's own shape, plus one non-wire field. */
export interface BuiltinResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  /**
   * NOT sent to the agent — the adapter strips it. Overrides the string whose
   * bytes/tokens usage counts for the response, for a tool that replays a
   * payload already billed elsewhere (`poll_task`).
   */
  usageResp?: string
}

/** A definition with its argument type erased, so definitions can share a list. */
export interface BuiltinTool {
  name: string
  /** Zod raw shape for the arguments; absent = the tool takes none. */
  inputShape?: z.ZodRawShape
  /** Zod raw shape for `structuredContent`, when the tool returns one. */
  outputShape?: z.ZodRawShape
  run(args: unknown, call: BuiltinCall): Promise<BuiltinResult>
}

/**
 * Declare a built-in. `run`'s `args` are typed from `inputShape`; the SDK has
 * already validated them against that same shape before `run` is called, so
 * the erasure to `unknown` in `BuiltinTool` loses nothing at runtime.
 */
export function defineBuiltin<S extends z.ZodRawShape = Record<string, never>>(def: {
  name: string
  inputShape?: S
  outputShape?: z.ZodRawShape
  run(args: z.infer<z.ZodObject<S>>, call: BuiltinCall): Promise<BuiltinResult>
}): BuiltinTool {
  return def as unknown as BuiltinTool
}

/** JSON text + the same object as `structuredContent` — the common result. */
export function jsonResult<T extends Record<string, unknown>>(body: T): BuiltinResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body
  }
}
