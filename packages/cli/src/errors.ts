/**
 * Typed CLI error. Thrown for any user-facing failure; main() catches
 * and exits with a friendly message. Stack traces only print under
 * CTXLAYER_DEBUG=1 to keep normal output clean.
 */
export class CtxlayerError extends Error {
  readonly code: string
  constructor(message: string, code = 'error') {
    super(message)
    this.code = code
  }
}

export function isDebug(): boolean {
  return process.env.CTXLAYER_DEBUG === '1'
}
