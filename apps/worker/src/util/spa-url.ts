/**
 * Absolute URL of a SPA page, for first-party text handed to agents (who
 * relay it to a human — a bare `/app/upstreams` is not clickable from a
 * chat client). Falls back to the bare path when `PUBLIC_BASE_URL` is unset
 * or malformed (test envs, a half-configured deploy) rather than throwing
 * inside a tool handler.
 */

import type { Env } from '../env'

export const UPSTREAMS_PAGE = '/app/upstreams'

export function spaUrl(env: Pick<Env, 'PUBLIC_BASE_URL'>, path: string): string {
  try {
    return new URL(path, env.PUBLIC_BASE_URL).toString()
  } catch {
    return path
  }
}
