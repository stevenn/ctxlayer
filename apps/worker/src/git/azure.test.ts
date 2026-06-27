import { afterEach, describe, expect, it, vi } from 'vitest'
import { AzureDevOpsProvider } from './azure'
import type { GitRepoConfig } from './provider-types'

// ADO carries org/project/repo in the path.
const config: GitRepoConfig = {
  provider: 'azure',
  baseUrl: null,
  owner: 'acme-org',
  project: 'Platform',
  repo: 'docs'
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('AzureDevOpsProvider read path', () => {
  it('lists only markdown blobs under the prefix, stripping the leading slash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain(
          '/acme-org/Platform/_apis/git/repositories/docs/items?scopePath=/&recursionLevel=Full'
        )
        expect(url).toContain('api-version=7.1')
        return jsonResponse({
          value: [
            { path: '/README.md', gitObjectType: 'blob', objectId: 'a' },
            { path: '/docs/guide.md', gitObjectType: 'blob', objectId: 'b' },
            { path: '/docs/img.png', gitObjectType: 'blob', objectId: 'c' },
            { path: '/docs', gitObjectType: 'tree', objectId: 'e' }
          ]
        })
      })
    )
    const az = new AzureDevOpsProvider(config, 'pat')
    const entries = await az.listMarkdownTree('main', 'docs')
    expect(entries.map((e) => e.path)).toEqual(['docs/guide.md'])
    expect(entries[0]?.blobSha).toBe('b')
  })

  it('reads raw file content + objectId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/items?path=%2Fdocs%2Fguide.md&includeContent=true')
        return jsonResponse({ objectId: 'b', content: '# Hi\n' })
      })
    )
    const az = new AzureDevOpsProvider(config, 'pat')
    const file = await az.readFile('docs/guide.md', 'main')
    expect(file.text).toBe('# Hi\n')
    expect(file.blobSha).toBe('b')
  })

  it('reports the default branch as a bare name (strips refs/heads/)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // The repository object itself — no /refs, /items, etc. suffix.
        expect(url).toContain('/_apis/git/repositories/docs?api-version=')
        return jsonResponse({ id: 'r1', name: 'docs', defaultBranch: 'refs/heads/master' })
      })
    )
    const az = new AzureDevOpsProvider(config, 'pat')
    expect(await az.getDefaultBranch()).toBe('master')
  })

  it('resolves a ref via the refs filter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/refs?filter=heads/main')
        return jsonResponse({ value: [{ name: 'refs/heads/main', objectId: 'deadbeef' }] })
      })
    )
    const az = new AzureDevOpsProvider(config, 'pat')
    expect(await az.resolveRef('main')).toBe('deadbeef')
  })

  it('builds blob web urls with the GB version token', () => {
    const az = new AzureDevOpsProvider(config, 'pat')
    expect(az.blobWebUrl('docs/guide.md', 'main')).toBe(
      'https://dev.azure.com/acme-org/Platform/_git/docs?path=%2Fdocs%2Fguide.md&version=GBmain'
    )
  })

  it('builds a new-PR deep link (branches only — ADO has no title/body prefill)', () => {
    const az = new AzureDevOpsProvider(config, 'pat')
    const url = az.newPrWebUrl({
      headBranch: 'ctxlayer/doc-x-abcd1234',
      baseRef: 'main',
      title: 'ignored',
      body: 'ignored'
    })
    expect(url).toBe(
      'https://dev.azure.com/acme-org/Platform/_git/docs/pullrequestcreate' +
        '?sourceRef=ctxlayer%2Fdoc-x-abcd1234&targetRef=main'
    )
  })

  it('maps PR status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 'completed' }))
    )
    const az = new AzureDevOpsProvider(config, 'pat')
    expect(await az.getPullRequestState('5')).toBe('merged')
  })

  it('throws a generic error without leaking the body', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'TF401019', token: 'super-secret' }, 404))
    )
    const az = new AzureDevOpsProvider(config, 'pat')
    await expect(az.resolveRef('main')).rejects.toThrow('azure_api_error:404')
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).not.toContain('super-secret')
    errSpy.mockRestore()
  })

  it('flags a 203 HTML sign-in interstitial as auth_failed, not ref_unresolved', async () => {
    // ADO answers a wrong-audience token with 203 + an HTML sign-in page; 203
    // is res.ok, so the old code read it as an empty ref list → the misleading
    // azure_ref_unresolved with no log. Now it's a clear, logged auth failure.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<html><body>Sign in to your account — https://login.microsoftonline.com/…</body></html>',
            { status: 203, headers: { 'content-type': 'text/html; charset=utf-8' } }
          )
      )
    )
    const az = new AzureDevOpsProvider(config, 'eyJhbGc.eyJ.wrongaud')
    await expect(az.resolveRef('main')).rejects.toThrow('azure_auth_failed')
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('auth_interstitial')
    expect(logged).not.toContain('login.microsoftonline.com') // HTML body not leaked
    errSpy.mockRestore()
  })
})

describe('AzureDevOpsProvider auth scheme', () => {
  it('uses Basic for a classic PAT and Bearer for an Entra JWT', async () => {
    const seen: string[] = []
    const grab = (init?: RequestInit) => {
      const h = new Headers(init?.headers)
      seen.push(h.get('authorization') ?? '')
    }
    // PAT → Basic base64(':pat')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        grab(init)
        return jsonResponse({ value: [{ objectId: 'x' }] })
      })
    )
    await new AzureDevOpsProvider(config, 'mypat').resolveRef('main')
    expect(seen[0]).toBe(`Basic ${btoa(':mypat')}`)

    // Entra access token (JWT) → Bearer
    const jwt = 'eyJhbGc.eyJzdWI.sig'
    await new AzureDevOpsProvider(config, jwt).resolveRef('main')
    expect(seen[1]).toBe(`Bearer ${jwt}`)
  })
})

describe('AzureDevOpsProvider write path', () => {
  it('creates the branch, pushes the commit, and opens a PR', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(init.body as string) : undefined
        calls.push({ method, url, body })
        if (method === 'GET' && url.includes('/refs?filter=heads/main')) {
          return jsonResponse({ value: [{ objectId: 'base-sha' }] })
        }
        if (method === 'POST' && url.includes('/refs?')) {
          return jsonResponse({ value: [{ success: true }] })
        }
        if (method === 'GET' && url.includes('/refs?filter=heads/ctxlayer')) {
          return jsonResponse({ value: [{ objectId: 'head-sha' }] })
        }
        // file doesn't exist yet on head branch → 'add'
        if (method === 'GET' && url.includes('/items?path=')) {
          return jsonResponse({ message: 'not found' }, 404)
        }
        if (method === 'POST' && url.includes('/pushes')) {
          return jsonResponse({ commits: [{ commitId: 'new' }] })
        }
        if (method === 'GET' && url.includes('/pullrequests?')) {
          return jsonResponse({ value: [] })
        }
        if (method === 'POST' && url.includes('/pullrequests')) {
          return jsonResponse({ pullRequestId: 77 })
        }
        throw new Error(`unexpected ${method} ${url}`)
      })
    )
    const az = new AzureDevOpsProvider(config, 'pat')
    const pr = await az.openOrUpdatePullRequest({
      baseRef: 'main',
      headBranch: 'ctxlayer/doc-x-abcd1234',
      path: 'docs/guide.md',
      content: '# New\n',
      commitMessage: 'docs: update',
      prTitle: 'Update docs/guide.md',
      prBody: 'from ctxlayer'
    })
    expect(pr).toEqual({
      providerPrId: '77',
      url: 'https://dev.azure.com/acme-org/Platform/_git/docs/pullrequest/77',
      branchName: 'ctxlayer/doc-x-abcd1234'
    })
    const push = calls.find((c) => c.method === 'POST' && c.url.includes('/pushes'))
    expect(push?.body).toMatchObject({
      refUpdates: [{ name: 'refs/heads/ctxlayer/doc-x-abcd1234', oldObjectId: 'head-sha' }],
      commits: [{ changes: [{ changeType: 'add', item: { path: '/docs/guide.md' } }] }]
    })
  })
})
