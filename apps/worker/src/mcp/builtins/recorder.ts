import { errorTextFromContent, scrubErrorForStorage } from '../../usage/error-detail'
import type { RecordUsageArgs } from '../../usage/record'
import { errMessage } from '../../util/errors'
import { safeJson } from '../tool-result'

/**
 * Usage-recording wrapper a lane supplies to the built-in adapters: runs
 * `exec`, records the call, and returns the result untouched.
 *
 * `opts.usageResp` overrides the string whose bytes/tokens are counted for
 * the response (the agent still receives `result.content` verbatim) — used by
 * `poll_task` so replaying a done job's result doesn't re-bill tokens the
 * queue consumer already counted under the real upstream tool.
 */
export type RecordBuiltin = <T extends { content?: unknown; isError?: boolean }>(
  tool: string,
  args: unknown,
  exec: () => Promise<T>,
  opts?: { usageResp?: (result: T) => string | undefined }
) => Promise<T>

/**
 * Build a lane's recorder. Both lanes record a built-in call the same way —
 * bytes/tokens/latency plus 'ok' / 'error' from the `isError` flag, with a
 * thrown error recorded and then re-thrown — and differ only in where the
 * usage event goes (`sink`: the session lane's DO outbox, or the stateless
 * lane's direct queue send) and how the caller is identified (`ids`, read at
 * call time).
 */
export function builtinRecorder(
  sink: (args: RecordUsageArgs) => Promise<void>,
  ids: () => { userId: string; sessionId: string }
): RecordBuiltin {
  return (tool, args, exec, opts) => {
    const t0 = Date.now()
    const reqJson = safeJson(args)
    const { userId, sessionId } = ids()
    // Built-ins have no upstream, so a failure is always `local_error`;
    // `errorSrc` is the raw detail (scrubbed here for the usage table).
    const finalize = (respJson: string, status: 'ok' | 'error', errorSrc?: string) =>
      sink({
        userId,
        sessionId,
        upstreamId: null,
        tool,
        reqJson,
        respJson,
        latencyMs: Date.now() - t0,
        status,
        ...(status === 'error'
          ? {
              errorCode: 'local_error',
              errorMessage: scrubErrorForStorage(errorSrc ?? respJson)
            }
          : {})
      })
    return exec().then(
      async (result) => {
        await finalize(
          opts?.usageResp?.(result) ?? safeJson(result.content),
          result.isError ? 'error' : 'ok',
          result.isError ? errorTextFromContent(result.content) : undefined
        )
        return result
      },
      async (err) => {
        const m = errMessage(err)
        await finalize(m, 'error', m)
        throw err
      }
    )
  }
}
