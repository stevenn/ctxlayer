/**
 * GitLab provider (gitlab.com + self-managed via a configurable base URL).
 * REST v4 only — no clone. The project is identified by `repo` (project path
 * or numeric id, URL-encoded). GitLab folds branch-create into the commit
 * call (`start_branch`) and opens the merge request separately.
 *
 * Security: never log GitLab response bodies — they can carry tokens or
 * internal detail. The `call` helper logs only `METHOD path -> status` plus
 * GitLab's non-secret `message`. Errors surfaced to callers are generic codes.
 */

import type { GitPrState } from '@ctxlayer/shared'
import type {
  GitFileContent,
  GitProviderClient,
  GitRepoConfig,
  GitTreeEntry,
  NewPrUrlInput,
  OpenedPr,
  OpenOrUpdatePrInput
} from './provider-types'
import { assertSafeFetchUrl } from '../util/safe-fetch'
import { gitlabApiBase, gitlabWebBase } from './url'
import { MD_RE, asObj, enc, encPath, fromBase64, normalizePrefix, underPrefix } from './provider-util'

const TREE_PER_PAGE = 100
const TREE_MAX_PAGES = 50 // cap the walk at ~5000 entries/page-loop

interface CallResult {
  status: number
  json: unknown
}

export class GitLabProvider implements GitProviderClient {
  private readonly api: string
  private readonly web: string
  /** `.../projects/<url-encoded id-or-path>` — the project-scoped API root. */
  private readonly projectPath: string
  /** Raw `repo` (project path) for building web URLs. */
  private readonly projectRef: string

  constructor(
    config: GitRepoConfig,
    private readonly token: string
  ) {
    this.api = gitlabApiBase(config.baseUrl)
    this.web = gitlabWebBase(config.baseUrl)
    this.projectRef = config.repo
    this.projectPath = `/projects/${enc(config.repo)}`
  }

  async resolveRef(ref: string): Promise<string> {
    const r = await this.call('GET', `${this.projectPath}/repository/branches/${enc(ref)}`)
    const sha = asObj(asObj(r.json).commit).id
    if (typeof sha !== 'string') throw new Error('gitlab_ref_unresolved')
    return sha
  }

  async listMarkdownTree(ref: string, pathPrefix: string): Promise<GitTreeEntry[]> {
    const prefix = normalizePrefix(pathPrefix)
    const out: GitTreeEntry[] = []
    // GitLab's tree endpoint is paginated; walk pages until a short page.
    for (let page = 1; page <= TREE_MAX_PAGES; page++) {
      const r = await this.call(
        'GET',
        `${this.projectPath}/repository/tree?ref=${enc(ref)}&recursive=true&per_page=${TREE_PER_PAGE}&page=${page}`
      )
      const items = Array.isArray(r.json) ? (r.json as Array<Record<string, unknown>>) : []
      for (const e of items) {
        const path = typeof e.path === 'string' ? e.path : ''
        const sha = typeof e.id === 'string' ? e.id : ''
        if (e.type !== 'blob' || !path || !sha) continue
        if (!MD_RE.test(path) || !underPrefix(path, prefix)) continue
        out.push({ path, blobSha: sha, size: 0 })
      }
      if (items.length < TREE_PER_PAGE) break
      if (page === TREE_MAX_PAGES) {
        console.warn(`gitlab: tree walk hit page cap for ${this.projectRef} — some files may be missed`)
      }
    }
    return out
  }

  async readFile(path: string, ref: string): Promise<GitFileContent> {
    // GitLab's files endpoint wants the FULL path URL-encoded (slashes → %2F).
    const r = await this.call(
      'GET',
      `${this.projectPath}/repository/files/${enc(path)}?ref=${enc(ref)}`
    )
    const j = asObj(r.json)
    const sha = typeof j.blob_id === 'string' ? j.blob_id : ''
    if (!sha) throw new Error('gitlab_not_a_file')
    const text =
      j.encoding === 'base64' && typeof j.content === 'string' ? fromBase64(j.content) : ''
    return { blobSha: sha, text }
  }

  blobWebUrl(path: string, ref: string): string {
    return `${this.web}/${this.projectRef}/-/blob/${enc(ref)}/${encPath(path)}`
  }

  async commitChange(input: OpenOrUpdatePrInput): Promise<void> {
    const headBranch = input.existingBranch ?? input.headBranch
    // Idempotent branch handling: the head branch may already exist from a
    // prior (possibly crashed) attempt on the deterministic name. If so we
    // commit onto it without start_branch; otherwise create it from baseRef.
    const branchExists = input.existingBranch
      ? true
      : (
          await this.call(
            'GET',
            `${this.projectPath}/repository/branches/${enc(headBranch)}`,
            { allow: [404] }
          )
        ).status === 200

    // 'update' an existing file, 'create' a new one — decided by whether the
    // file is already present on the ref we'll commit onto.
    const probeRef = branchExists ? headBranch : input.baseRef
    const probe = await this.call(
      'GET',
      `${this.projectPath}/repository/files/${enc(input.path)}?ref=${enc(probeRef)}`,
      { allow: [404] }
    )
    const action = probe.status === 200 ? 'update' : 'create'

    await this.call('POST', `${this.projectPath}/repository/commits`, {
      body: {
        branch: headBranch,
        ...(branchExists ? {} : { start_branch: input.baseRef }),
        commit_message: input.commitMessage,
        actions: [{ action, file_path: input.path, content: input.content }]
      },
      // Tolerate 400 on retry (e.g. re-committing identical content to a branch
      // a prior attempt already pushed). MR/caller resolution is the real check.
      allow: [400]
    })
  }

  newPrWebUrl(input: NewPrUrlInput): string {
    const q = new URLSearchParams({
      'merge_request[source_branch]': input.headBranch,
      'merge_request[target_branch]': input.baseRef,
      'merge_request[title]': input.title,
      'merge_request[description]': input.body
    })
    return `${this.web}/${this.projectRef}/-/merge_requests/new?${q.toString()}`
  }

  async openOrUpdatePullRequest(input: OpenOrUpdatePrInput): Promise<OpenedPr> {
    await this.commitChange(input)
    const headBranch = input.existingBranch ?? input.headBranch
    let mr = await this.findOpenMr(headBranch, input.baseRef)
    if (!mr) {
      const opened = await this.call('POST', `${this.projectPath}/merge_requests`, {
        body: {
          source_branch: headBranch,
          target_branch: input.baseRef,
          title: input.prTitle,
          description: input.prBody
        },
        allow: [409] // an MR for this branch pair already exists
      })
      mr = opened.status === 409 ? await this.findOpenMr(headBranch, input.baseRef) : asObj(opened.json)
    }
    const iid = mr?.iid
    const url = mr?.web_url
    if (typeof iid !== 'number' || typeof url !== 'string') throw new Error('gitlab_mr_not_resolved')
    return { providerPrId: String(iid), url, branchName: headBranch }
  }

  async getPullRequestState(providerPrId: string): Promise<GitPrState> {
    const r = await this.call('GET', `${this.projectPath}/merge_requests/${enc(providerPrId)}`)
    const state = asObj(r.json).state
    if (state === 'merged') return 'merged'
    if (state === 'closed' || state === 'locked') return 'closed'
    if (state === 'opened') return 'open'
    return 'error'
  }

  // ----- internals -------------------------------------------------------

  private async findOpenMr(
    headBranch: string,
    baseRef: string
  ): Promise<Record<string, unknown> | null> {
    const r = await this.call(
      'GET',
      `${this.projectPath}/merge_requests?source_branch=${enc(headBranch)}&target_branch=${enc(baseRef)}&state=opened`
    )
    return Array.isArray(r.json) && r.json.length > 0 ? asObj(r.json[0]) : null
  }

  private headers(withBody: boolean): HeadersInit {
    // Bearer carries both PATs and OAuth tokens on GitLab.
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
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
      // GitLab's `message`/`error` is a non-secret summary (the token is never
      // echoed). Log it for diagnostics; never log the full body.
      const body = json as { message?: unknown; error?: unknown } | null
      const message =
        typeof body?.message === 'string'
          ? body.message
          : typeof body?.error === 'string'
            ? body.error
            : ''
      console.error(`gitlab: ${method} ${url} -> ${res.status}` + (message ? ` :: ${message}` : ''))
      throw new Error(`gitlab_api_error:${res.status}`)
    }
    return { status: res.status, json }
  }
}
