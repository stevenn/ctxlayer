import { describe, expect, it } from 'vitest'
import { upstreamAuthHeaders } from './http-client'

describe('upstreamAuthHeaders', () => {
  it('defaults to a single Authorization: Bearer header', () => {
    expect(upstreamAuthHeaders(undefined, 'sk-secret')).toEqual({
      Authorization: 'Bearer sk-secret'
    })
  })

  it('honours a configured header name and prefix', () => {
    expect(
      upstreamAuthHeaders({ headerName: 'X-Notion-Auth', headerPrefix: 'Token ' }, 'sk-secret')
    ).toEqual({ 'X-Notion-Auth': 'Token sk-secret' })
  })

  it('sends nothing when there is no credential', () => {
    expect(upstreamAuthHeaders({ headerName: 'X-Api-Key', headerPrefix: '' }, null)).toEqual({})
  })

  it('carries extraHeaders alongside the sealed credential', () => {
    // A Cloudflare Access service token: the id is an identifier held in
    // config, the secret rides the sealed slot. Neither works without the other.
    expect(
      upstreamAuthHeaders(
        {
          headerName: 'CF-Access-Client-Secret',
          headerPrefix: '',
          extraHeaders: { 'CF-Access-Client-Id': 'abc123.access' }
        },
        'sk-secret'
      )
    ).toEqual({
      'CF-Access-Client-Id': 'abc123.access',
      'CF-Access-Client-Secret': 'sk-secret'
    })
  })

  it('still sends extraHeaders when no credential is configured', () => {
    expect(
      upstreamAuthHeaders(
        {
          headerName: 'Authorization',
          headerPrefix: 'Bearer ',
          extraHeaders: { 'X-Tenant': 'yuki' }
        },
        null
      )
    ).toEqual({ 'X-Tenant': 'yuki' })
  })

  it('never lets extraHeaders shadow the sealed credential', () => {
    // Config is not encrypted; the sealed token must win whatever the JSON says.
    expect(
      upstreamAuthHeaders(
        {
          headerName: 'Authorization',
          headerPrefix: 'Bearer ',
          extraHeaders: { Authorization: 'Bearer attacker-chosen' }
        },
        'sk-real'
      )
    ).toEqual({ Authorization: 'Bearer sk-real' })
  })
})
