import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Loopback HTTP server for OAuth redirect URI per RFC 8252. Listens on
 * an ephemeral port (kernel picks); resolves with the assigned port +
 * a Promise that fires when the browser callback hits /cb.
 *
 * Auto-closes 5 minutes after listen() to bound the wait. Caller can
 * also close() explicitly after a successful auth.
 */
const TIMEOUT_MS = 5 * 60 * 1000

export interface LoopbackResult {
  port: number
  waitForCode(): Promise<{ code: string; state: string }>
  close(): void
}

export async function startLoopback(): Promise<LoopbackResult> {
  let resolveCode!: (v: { code: string; state: string }) => void
  let rejectCode!: (err: Error) => void
  const codePromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    if (url.pathname !== '/cb') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const err = url.searchParams.get('error')
    if (err) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(htmlPage(`Sign-in failed: ${escapeHtml(err)}. You can close this tab.`))
      rejectCode(new Error(`oauth_error: ${err}`))
      return
    }
    if (!code || !state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(htmlPage('Missing code/state parameter. You can close this tab.'))
      rejectCode(new Error('oauth_callback_missing_params'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(htmlPage('Sign-in complete. You can close this tab and return to the terminal.'))
    resolveCode({ code, state })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const timeout = setTimeout(() => {
    rejectCode(new Error('oauth_login_timeout'))
    server.close()
  }, TIMEOUT_MS)

  return {
    port,
    waitForCode: () =>
      codePromise.finally(() => {
        clearTimeout(timeout)
        server.close()
      }),
    close: () => {
      clearTimeout(timeout)
      server.close()
    }
  }
}

function htmlPage(message: string): string {
  return `<!doctype html><html><head><title>ctxlayer</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:48px;color:#222;background:#fafafa}h1{font-size:20px;margin:0 0 16px}</style>
</head><body><h1>ctxlayer CLI</h1><p>${escapeHtml(message)}</p></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>'"]/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;'
  )
}
