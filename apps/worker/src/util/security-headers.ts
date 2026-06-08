/**
 * Strict-Transport-Security for worker-served responses (/api, /mcp,
 * /oauth, /idp, …). HSTS tells the browser to refuse plain-HTTP for this
 * host, defeating SSL-strip / downgrade MITM.
 *
 * Static-asset responses (the SPA shell, /assets/*) bypass the worker
 * entirely (see `run_worker_first` in wrangler.toml), so they carry the
 * same header from `apps/web/dist/_headers`. That HSTS line is injected at
 * DEPLOY time by `scripts/deploy.mjs` — never committed — so `wrangler dev`
 * doesn't ship it locally. This helper is the worker-side counterpart;
 * together they cover every response on a deployed tenant host.
 *
 * Why the localhost guard: an HSTS header received over `https://localhost`
 * pins the browser's ENTIRE `localhost` (HSTS is host-scoped, ignores port)
 * to HTTPS, which then breaks every other local dev server on
 * `http://localhost:*`. Production `PUBLIC_BASE_URL` is never localhost, so
 * gating on the request host keeps dev safe without weakening prod.
 */

const HSTS_VALUE = 'max-age=31536000; includeSubDomains'

export function withHsts(req: Request, res: Response): Response {
  if (isLocalRequest(req)) return res
  // 1xx (incl. 101 WebSocket upgrades for /collab) can't be passed to the
  // Response constructor and carry no browser-cacheable headers — leave
  // them untouched.
  if (res.status < 200 || (res as { webSocket?: unknown }).webSocket) return res
  if (res.headers.has('Strict-Transport-Security')) return res
  // `new Response(body, res)` re-uses the (streaming) body and copies
  // status/statusText/headers into a fresh, mutable Headers instance.
  const out = new Response(res.body, res)
  out.headers.set('Strict-Transport-Security', HSTS_VALUE)
  return out
}

function isLocalRequest(req: Request): boolean {
  try {
    const host = new URL(req.url).hostname
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}
