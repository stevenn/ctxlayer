/**
 * GitHub provider (github.com + GitHub Enterprise via configurable base
 * URL). REST only — no clone. Reads walk the recursive git tree and
 * fetch single files; writes create a head branch, commit the file, and
 * open (or refresh) a PR.
 *
 * Security: never log GitHub response bodies — they can carry tokens or
 * internal detail. The `call` helper logs only `METHOD path -> status`.
 * Errors surfaced to callers are generic codes; the real text never
 * leaves this module.
 */

import type { GitPrState } from '@ctxlayer/shared'
import type {
  GitFileContent,
  GitProviderClient,
  GitRepoConfig,
  GitTreeEntry,
  OpenedPr,
  OpenOrUpdatePrInput
} from './provider'
import { assertSafeFetchUrl, githubApiBase, githubWebBase } from './url'

const MD_RE = /\.(md|mdown|markdown|mkd)$/i

interface CallResult {
  status: number
  json: unknown
}

export class GitHubProvider implements GitProviderClient {
  private readonly api: string
  private readonly web: string
  private readonly owner: string
  private readonly repo: string
  private readonly repoPath: string

  constructor(
    config: GitRepoConfig,
    private readonly token: string
  ) {
    this.api = githubApiBase(config.baseUrl)
    this.web = githubWebBase(config.baseUrl)
    this.owner = config.owner
    this.repo = config.repo
    this.repoPath = `/repos/${enc(this.owner)}/${enc(this.repo)}`
  }

  async resolveRef(ref: string): Promise<string> {
    const r = await this.call('GET', `${this.repoPath}/commits/${enc(ref)}`)
    const sha = asObj(r.json).sha
    if (typeof sha !== 'string') throw new Error('github_ref_unresolved')
    return sha
  }

  async listMarkdownTree(ref: string, pathPrefix: string): Promise<GitTreeEntry[]> {
    const r = await this.call('GET', `${this.repoPath}/git/trees/${enc(ref)}?recursive=1`)
    const body = asObj(r.json)
    if (body.truncated) {
      console.warn(`github: tree truncated for ${this.owner}/${this.repo} — some files may be missed`)
    }
    const tree = Array.isArray(body.tree) ? (body.tree as Array<Record<string, unknown>>) : []
    const prefix = normalizePrefix(pathPrefix)
    const out: GitTreeEntry[] = []
    for (const e of tree) {
      const path = typeof e.path === 'string' ? e.path : ''
      const sha = typeof e.sha === 'string' ? e.sha : ''
      if (e.type !== 'blob' || !path || !sha) continue
      if (!MD_RE.test(path) || !underPrefix(path, prefix)) continue
      out.push({ path, blobSha: sha, size: typeof e.size === 'number' ? e.size : 0 })
    }
    return out
  }

  async readFile(path: string, ref: string): Promise<GitFileContent> {
    const r = await this.call('GET', `${this.repoPath}/contents/${encPath(path)}?ref=${enc(ref)}`)
    const j = asObj(r.json)
    if (j.type !== 'file' || typeof j.sha !== 'string') throw new Error('github_not_a_file')
    let text: string
    if (j.encoding === 'base64' && typeof j.content === 'string' && j.content.length > 0) {
      text = fromBase64(j.content)
    } else {
      // Large file (>1MB): the contents API omits `content`; fetch the blob.
      const blob = await this.call('GET', `${this.repoPath}/git/blobs/${enc(j.sha)}`)
      const bj = asObj(blob.json)
      text = typeof bj.content === 'string' ? fromBase64(bj.content) : ''
    }
    return { blobSha: j.sha, text }
  }

  blobWebUrl(path: string, ref: string): string {
    return `${this.web}/${enc(this.owner)}/${enc(this.repo)}/blob/${enc(ref)}/${encPath(path)}`
  }

  async openOrUpdatePullRequest(input: OpenOrUpdatePrInput): Promise<OpenedPr> {
    const headBranch = input.existingBranch ?? input.headBranch

    if (!input.existingBranch) {
      const baseRef = await this.call('GET', `${this.repoPath}/git/ref/heads/${enc(input.baseRef)}`)
      const baseSha = asObj(asObj(baseRef.json).object).sha
      if (typeof baseSha !== 'string') throw new Error('github_base_ref_missing')
      // Create the head branch; 422 = already exists (re-running a PR).
      await this.call(
        'POST',
        `${this.repoPath}/git/refs`,
        { body: { ref: `refs/heads/${headBranch}`, sha: baseSha }, allow: [422] }
      )
    }

    // Current file sha on the head branch (needed to update; 404 = new file).
    const existing = await this.call(
      'GET',
      `${this.repoPath}/contents/${encPath(input.path)}?ref=${enc(headBranch)}`,
      { allow: [404] }
    )
    const fileSha = existing.status === 200 ? asObj(existing.json).sha : undefined

    await this.call('PUT', `${this.repoPath}/contents/${encPath(input.path)}`, {
      body: {
        message: input.commitMessage,
        content: toBase64(input.content),
        branch: headBranch,
        ...(typeof fileSha === 'string' ? { sha: fileSha } : {})
      }
    })

    let pr = await this.findOpenPr(headBranch, input.baseRef)
    if (!pr) {
      const opened = await this.call('POST', `${this.repoPath}/pulls`, {
        body: { title: input.prTitle, head: headBranch, base: input.baseRef, body: input.prBody },
        allow: [422]
      })
      pr = opened.status === 422 ? await this.findOpenPr(headBranch, input.baseRef) : asObj(opened.json)
    }
    const number = pr?.number
    const url = pr?.html_url
    if (typeof number !== 'number' || typeof url !== 'string') {
      throw new Error('github_pr_not_resolved')
    }
    return { providerPrId: String(number), url, branchName: headBranch }
  }

  async getPullRequestState(providerPrId: string): Promise<GitPrState> {
    const r = await this.call('GET', `${this.repoPath}/pulls/${enc(providerPrId)}`)
    const pr = asObj(r.json)
    if (pr.merged === true) return 'merged'
    if (pr.state === 'closed') return 'closed'
    if (pr.state === 'open') return 'open'
    return 'error'
  }

  // ----- internals -------------------------------------------------------

  private async findOpenPr(headBranch: string, baseRef: string): Promise<Record<string, unknown> | null> {
    const r = await this.call(
      'GET',
      `${this.repoPath}/pulls?head=${enc(this.owner)}:${enc(headBranch)}&base=${enc(baseRef)}&state=open`
    )
    return Array.isArray(r.json) && r.json.length > 0 ? asObj(r.json[0]) : null
  }

  private headers(withBody: boolean): HeadersInit {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ctxlayer'
    }
    if (withBody) h['Content-Type'] = 'application/json'
    return h
  }

  private async call(
    method: string,
    path: string,
    opts?: { body?: unknown; allow?: number[] }
  ): Promise<CallResult> {
    const url = `${this.api}${path}`
    assertSafeFetchUrl(url)
    const init: RequestInit = { method, headers: this.headers(opts?.body !== undefined) }
    if (opts?.body !== undefined) init.body = JSON.stringify(opts.body)
    const res = await fetch(url, init)
    const text = await res.text()
    let json: unknown = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    if (!res.ok && !(opts?.allow ?? []).includes(res.status)) {
      // Status + path only — never the body.
      console.error(`github: ${method} ${path} -> ${res.status}`)
      throw new Error(`github_api_error:${res.status}`)
    }
    return { status: res.status, json }
  }
}

// ----- helpers -----------------------------------------------------------

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function enc(s: string): string {
  return encodeURIComponent(s)
}

/** Encode a repo path, preserving '/' separators. */
function encPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, '')
}

function underPrefix(path: string, prefix: string): boolean {
  if (!prefix) return true
  return path === prefix || path.startsWith(`${prefix}/`)
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
