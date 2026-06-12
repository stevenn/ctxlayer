import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../env'
import { buildAlertPayload, notify } from './alert'

const baseEnv = {
  GIT_SHA: 'abc1234',
  PUBLIC_BASE_URL: 'https://ctxlayer.example.com'
} as unknown as Env

describe('buildAlertPayload', () => {
  it('formats a human one-liner with host + sha + event', () => {
    const p = buildAlertPayload(baseEnv, {
      level: 'error',
      event: 'cron.git_sync_failed',
      detail: 'boom'
    })
    expect(p.text).toBe('🔴 ctxlayer ctxlayer.example.com [abc1234] cron.git_sync_failed: boom')
    expect(p).toMatchObject({ level: 'error', event: 'cron.git_sync_failed', host: 'ctxlayer.example.com' })
  })

  it('degrades host + sha gracefully when unset', () => {
    const p = buildAlertPayload({} as Env, { level: 'warn', event: 'queue.unknown' })
    expect(p.text).toBe('🟠 ctxlayer unknown [dev] queue.unknown')
  })
})

describe('notify', () => {
  it('no-ops (no fetch) when ALERT_WEBHOOK_URL is unset', async () => {
    const doFetch = vi.fn()
    await notify(baseEnv, { level: 'error', event: 'x' }, doFetch as unknown as typeof fetch)
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('POSTs the payload when configured', async () => {
    const doFetch = vi.fn(async () => new Response(null, { status: 200 }))
    const env = { ...baseEnv, ALERT_WEBHOOK_URL: 'https://hook.example/x' } as unknown as Env
    await notify(env, { level: 'error', event: 'reindex.poison', detail: 'doc=d1' }, doFetch as unknown as typeof fetch)
    expect(doFetch).toHaveBeenCalledOnce()
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://hook.example/x')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toMatchObject({ event: 'reindex.poison', detail: 'doc=d1' })
  })

  it('swallows a webhook failure (never throws)', async () => {
    const doFetch = vi.fn(async () => {
      throw new Error('hook down')
    })
    const env = { ...baseEnv, ALERT_WEBHOOK_URL: 'https://hook.example/x' } as unknown as Env
    await expect(
      notify(env, { level: 'error', event: 'x' }, doFetch as unknown as typeof fetch)
    ).resolves.toBeUndefined()
  })
})
