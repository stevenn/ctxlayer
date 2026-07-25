/**
 * One canonical way to turn an unknown thrown value into a string.
 *
 * `catch (err)` binds `unknown`, so every call site that wants to log or
 * classify the failure needs this narrowing. It was hand-rolled ~37 times
 * across 27 modules (and named `errText` / `stringifyError` / `errMessage`
 * depending on the folder); a single implementation keeps the rendering of a
 * non-Error throw consistent everywhere.
 *
 * NOTE: the result is the raw message. It is safe for SERVER-SIDE logs, but
 * anything bound for the agent or the wire must go through
 * `mcp/upstream-error.ts` (sanitised, generic code) — upstream messages can
 * carry API keys, internal hostnames, and stack frames.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
