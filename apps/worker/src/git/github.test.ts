import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubProvider } from './github'
import type { GitRepoConfig } from './provider'

const config: GitRepoConfig = {
  provider: 'github',
  baseUrl: null,
  owner: 'acme',
  repo: 'docs',
  project: ''
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('GitHubProvider read path', () => {
  it('lists only markdown blobs under the prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/repos/acme/docs/git/trees/main?recursive=1')
        return jsonResponse({
          truncated: false,
          tree: [
            { path: 'README.md', type: 'blob', sha: 'a', size: 1 },
            { path: 'docs/guide.md', type: 'blob', sha: 'b', size: 2 },
            { path: 'docs/img.png', type: 'blob', sha: 'c', size: 3 },
            { path: 'src/code.ts', type: 'blob', sha: 'd', size: 4 },
            { path: 'docs', type: 'tree', sha: 'e' }
          ]
        })
      })
    )
    const gh = new GitHubProvider(config, 't')
    const entries = await gh.listMarkdownTree('main', 'docs')
    expect(entries.map((e) => e.path)).toEqual(['docs/guide.md'])
    expect(entries[0]?.blobSha).toBe('b')
  })

  it('decodes base64 file content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/repos/acme/docs/contents/docs/guide.md?ref=main')
        return jsonResponse({
          type: 'file',
          sha: 'b',
          encoding: 'base64',
          content: btoa('# Hello\n')
        })
      })
    )
    const gh = new GitHubProvider(config, 't')
    const file = await gh.readFile('docs/guide.md', 'main')
    expect(file.text).toBe('# Hello\n')
    expect(file.blobSha).toBe('b')
  })

  it('builds blob web urls', () => {
    const gh = new GitHubProvider(config, 't')
    expect(gh.blobWebUrl('docs/guide.md', 'main')).toBe(
      'https://github.com/acme/docs/blob/main/docs/guide.md'
    )
  })

  it('builds a prefilled compare/new-PR deep link', () => {
    const gh = new GitHubProvider(config, 't')
    const url = gh.newPrWebUrl({
      headBranch: 'ctxlayer/doc-x-abcd1234',
      baseRef: 'main',
      title: 'Update docs/guide.md',
      body: 'hello'
    })
    expect(url).toContain('/acme/docs/compare/main...ctxlayer%2Fdoc-x-abcd1234?')
    expect(url).toContain('quick_pull=1')
    expect(url).toContain('title=Update+docs%2Fguide.md')
    expect(url).toContain('body=hello')
  })

  it('resolves a ref to a commit sha', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ sha: 'deadbeef' }))
    )
    const gh = new GitHubProvider(config, 't')
    expect(await gh.resolveRef('main')).toBe('deadbeef')
  })

  it('throws a generic error on api failure without leaking the body', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'Bad credentials', token: 'super-secret' }, 401))
    )
    const gh = new GitHubProvider(config, 't')
    await expect(gh.resolveRef('main')).rejects.toThrow('github_api_error:401')
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).not.toContain('super-secret')
    errSpy.mockRestore()
  })
})

describe('GitHubProvider Enterprise base url', () => {
  it('targets /api/v3 and the instance web host', () => {
    const gh = new GitHubProvider({ ...config, baseUrl: 'https://git.acme.io' }, 't')
    expect(gh.blobWebUrl('a.md', 'main')).toBe('https://git.acme.io/acme/docs/blob/main/a.md')
  })
})
