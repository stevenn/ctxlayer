import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabProvider } from './gitlab'
import type { GitRepoConfig } from './provider'

// GitLab identifies the project by `repo` (path or numeric id), URL-encoded.
const config: GitRepoConfig = {
  provider: 'gitlab',
  baseUrl: null,
  owner: '',
  project: '',
  repo: 'group/docs'
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('GitLabProvider read path', () => {
  it('lists only markdown blobs under the prefix (single page)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // project path is URL-encoded: group%2Fdocs
        expect(url).toContain('/projects/group%2Fdocs/repository/tree?ref=main&recursive=true')
        return jsonResponse([
          { path: 'README.md', type: 'blob', id: 'a' },
          { path: 'docs/guide.md', type: 'blob', id: 'b' },
          { path: 'docs/img.png', type: 'blob', id: 'c' },
          { path: 'docs', type: 'tree', id: 'e' }
        ])
      })
    )
    const gl = new GitLabProvider(config, 't')
    const entries = await gl.listMarkdownTree('main', 'docs')
    expect(entries.map((e) => e.path)).toEqual(['docs/guide.md'])
    expect(entries[0]?.blobSha).toBe('b')
  })

  it('decodes base64 file content and uses blob_id as the sha', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // full file path is URL-encoded (slashes → %2F)
        expect(url).toContain('/repository/files/docs%2Fguide.md?ref=main')
        return jsonResponse({ blob_id: 'b', encoding: 'base64', content: btoa('# Hi\n') })
      })
    )
    const gl = new GitLabProvider(config, 't')
    const file = await gl.readFile('docs/guide.md', 'main')
    expect(file.text).toBe('# Hi\n')
    expect(file.blobSha).toBe('b')
  })

  it('resolves a ref to a commit sha', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ name: 'main', commit: { id: 'deadbeef' } }))
    )
    const gl = new GitLabProvider(config, 't')
    expect(await gl.resolveRef('main')).toBe('deadbeef')
  })

  it('builds blob web urls', () => {
    const gl = new GitLabProvider(config, 't')
    expect(gl.blobWebUrl('docs/guide.md', 'main')).toBe(
      'https://gitlab.com/group/docs/-/blob/main/docs/guide.md'
    )
  })

  it('maps merge-request state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ state: 'merged' }))
    )
    const gl = new GitLabProvider(config, 't')
    expect(await gl.getPullRequestState('7')).toBe('merged')
  })

  it('throws a generic error on api failure without leaking the body', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: '404 Project Not Found', token: 'super-secret' }, 404))
    )
    const gl = new GitLabProvider(config, 't')
    await expect(gl.resolveRef('main')).rejects.toThrow('gitlab_api_error:404')
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).not.toContain('super-secret')
    errSpy.mockRestore()
  })
})

describe('GitLabProvider write path', () => {
  it('creates a branch + commit + MR in the expected calls', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(init.body as string) : undefined
        calls.push({ method, url, body })
        // head branch doesn't exist yet
        if (method === 'GET' && url.includes('/repository/branches/ctxlayer')) {
          return jsonResponse({ message: '404' }, 404)
        }
        // file is new on baseRef
        if (method === 'GET' && url.includes('/repository/files/')) {
          return jsonResponse({ message: '404' }, 404)
        }
        // no open MR yet
        if (method === 'GET' && url.includes('/merge_requests?')) {
          return jsonResponse([])
        }
        if (method === 'POST' && url.endsWith('/repository/commits')) {
          return jsonResponse({ id: 'commit-sha' })
        }
        if (method === 'POST' && url.endsWith('/merge_requests')) {
          return jsonResponse({ iid: 42, web_url: 'https://gitlab.com/group/docs/-/merge_requests/42' })
        }
        throw new Error(`unexpected ${method} ${url}`)
      })
    )
    const gl = new GitLabProvider(config, 't')
    const pr = await gl.openOrUpdatePullRequest({
      baseRef: 'main',
      headBranch: 'ctxlayer/doc-x-abcd1234',
      path: 'docs/guide.md',
      content: '# New\n',
      commitMessage: 'docs: update',
      prTitle: 'Update docs/guide.md',
      prBody: 'from ctxlayer'
    })
    expect(pr).toEqual({
      providerPrId: '42',
      url: 'https://gitlab.com/group/docs/-/merge_requests/42',
      branchName: 'ctxlayer/doc-x-abcd1234'
    })
    const commit = calls.find((c) => c.method === 'POST' && c.url.endsWith('/repository/commits'))
    expect(commit?.body).toMatchObject({
      branch: 'ctxlayer/doc-x-abcd1234',
      start_branch: 'main',
      actions: [{ action: 'create', file_path: 'docs/guide.md', content: '# New\n' }]
    })
  })
})

describe('GitLabProvider self-managed base url', () => {
  it('targets /api/v4 and the instance web host', () => {
    const gl = new GitLabProvider({ ...config, baseUrl: 'https://gitlab.acme.io' }, 't')
    expect(gl.blobWebUrl('a.md', 'main')).toBe('https://gitlab.acme.io/group/docs/-/blob/main/a.md')
  })
})
