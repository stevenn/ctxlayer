/**
 * Azure DevOps provider (dev.azure.com + on-prem Server via a configurable
 * base URL). REST 7.1, no clone. ADO carries org/project/repo in the path
 * (`owner`=org, `project`, `repo`), commits via a `pushes` call that takes the
 * parent commit's `oldObjectId` + per-file `changeType`, and opens the PR
 * separately.
 *
 * Auth: the token may be an Entra OAuth access token (a JWT → `Bearer`) or a
 * classic PAT (opaque → HTTP Basic with an empty user). We detect the shape so
 * the same provider serves both the existing PAT path and the future Entra
 * flow without an interface change.
 *
 * Security: never log ADO response bodies. The `call` helper logs only
 * `METHOD path -> status`; errors surfaced to callers are generic codes.
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
import { azureBase } from './url'
import {
  MD_RE,
  asObj,
  enc,
  jsonMessage,
  normalizePrefix,
  providerCall,
  underPrefix,
  type CallResult
} from './provider-util'

const API_VERSION = '7.1'
const ZERO_SHA = '0'.repeat(40)

export class AzureDevOpsProvider implements GitProviderClient {
  /** `.../{org}/{project}/_apis/git/repositories/{repo}` — repo-scoped API. */
  private readonly api: string
  /** `.../{org}/{project}/_git/{repo}` — web base for links + PR pages. */
  private readonly web: string

  constructor(
    config: GitRepoConfig,
    private readonly token: string
  ) {
    const base = azureBase(config.baseUrl)
    const scope = `${enc(config.owner)}/${enc(config.project)}`
    this.api = `${base}/${scope}/_apis/git/repositories/${enc(config.repo)}`
    this.web = `${base}/${scope}/_git/${enc(config.repo)}`
  }

  async resolveRef(ref: string): Promise<string> {
    const r = await this.call('GET', `/refs?filter=heads/${enc(ref)}`)
    const value = asArray(asObj(r.json).value)
    const sha = asObj(value[0]).objectId
    if (typeof sha !== 'string') throw new Error('azure_ref_unresolved')
    return sha
  }

  async listMarkdownTree(ref: string, pathPrefix: string): Promise<GitTreeEntry[]> {
    const r = await this.call(
      'GET',
      `/items?scopePath=/&recursionLevel=Full` +
        `&versionDescriptor.version=${enc(ref)}&versionDescriptor.versionType=branch`
    )
    const items = asArray(asObj(r.json).value)
    const prefix = normalizePrefix(pathPrefix)
    const out: GitTreeEntry[] = []
    for (const e of items) {
      const o = asObj(e)
      // ADO item paths are absolute ('/docs/x.md'); strip the leading slash.
      const path = typeof o.path === 'string' ? o.path.replace(/^\//, '') : ''
      const sha = typeof o.objectId === 'string' ? o.objectId : ''
      if (o.gitObjectType !== 'blob' || !path || !sha) continue
      if (!MD_RE.test(path) || !underPrefix(path, prefix)) continue
      out.push({ path, blobSha: sha, size: 0 })
    }
    return out
  }

  async readFile(path: string, ref: string): Promise<GitFileContent> {
    const r = await this.call(
      'GET',
      `/items?path=${enc(`/${path}`)}&includeContent=true&$format=json` +
        `&versionDescriptor.version=${enc(ref)}&versionDescriptor.versionType=branch`
    )
    const j = asObj(r.json)
    const sha = typeof j.objectId === 'string' ? j.objectId : ''
    if (!sha) throw new Error('azure_not_a_file')
    return { blobSha: sha, text: typeof j.content === 'string' ? j.content : '' }
  }

  blobWebUrl(path: string, ref: string): string {
    return `${this.web}?path=${enc(`/${path}`)}&version=GB${enc(ref)}`
  }

  async commitChange(input: OpenOrUpdatePrInput): Promise<void> {
    const headBranch = input.existingBranch ?? input.headBranch

    // Ensure the head branch exists, branched from baseRef (idempotent on the
    // deterministic name). ADO needs the parent commit's sha to push onto.
    let headSha: string
    if (input.existingBranch) {
      headSha = await this.resolveRef(input.existingBranch)
    } else {
      const baseSha = await this.resolveRef(input.baseRef)
      // Create refs/heads/<headBranch> at baseSha. The per-item updateStatus is
      // 'success' for a fresh branch or a conflict code if it already exists
      // (a prior attempt) — either way we resolve its current head next.
      await this.call('POST', `/refs`, {
        body: [{ name: `refs/heads/${headBranch}`, oldObjectId: ZERO_SHA, newObjectId: baseSha }]
      })
      headSha = await this.resolveRef(headBranch)
    }

    // 'edit' an existing file, 'add' a new one — by whether it's on headBranch.
    const probe = await this.call(
      'GET',
      `/items?path=${enc(`/${input.path}`)}` +
        `&versionDescriptor.version=${enc(headBranch)}&versionDescriptor.versionType=branch`,
      { allow: [404] }
    )
    const changeType = probe.status === 200 ? 'edit' : 'add'

    await this.call('POST', `/pushes`, {
      body: {
        refUpdates: [{ name: `refs/heads/${headBranch}`, oldObjectId: headSha }],
        commits: [
          {
            comment: input.commitMessage,
            changes: [
              {
                changeType,
                item: { path: `/${input.path}` },
                newContent: { content: input.content, contentType: 'rawtext' }
              }
            ]
          }
        ]
      }
    })
  }

  newPrWebUrl(input: NewPrUrlInput): string {
    // ADO's create page prefills the branches only (no title/body params).
    const q = new URLSearchParams({ sourceRef: input.headBranch, targetRef: input.baseRef })
    return `${this.web}/pullrequestcreate?${q.toString()}`
  }

  async openOrUpdatePullRequest(input: OpenOrUpdatePrInput): Promise<OpenedPr> {
    await this.commitChange(input)
    const headBranch = input.existingBranch ?? input.headBranch
    let pr = await this.findActivePr(headBranch, input.baseRef)
    if (!pr) {
      const opened = await this.call('POST', `/pullrequests`, {
        body: {
          sourceRefName: `refs/heads/${headBranch}`,
          targetRefName: `refs/heads/${input.baseRef}`,
          title: input.prTitle,
          description: input.prBody
        }
      })
      pr = asObj(opened.json)
    }
    const id = pr?.pullRequestId
    if (typeof id !== 'number') throw new Error('azure_pr_not_resolved')
    return { providerPrId: String(id), url: `${this.web}/pullrequest/${id}`, branchName: headBranch }
  }

  async getPullRequestState(providerPrId: string): Promise<GitPrState> {
    const r = await this.call('GET', `/pullrequests/${enc(providerPrId)}`)
    const status = asObj(r.json).status
    if (status === 'completed') return 'merged'
    if (status === 'abandoned') return 'closed'
    if (status === 'active') return 'open'
    return 'error'
  }

  // ----- internals -------------------------------------------------------

  private async findActivePr(
    headBranch: string,
    baseRef: string
  ): Promise<Record<string, unknown> | null> {
    const r = await this.call(
      'GET',
      `/pullrequests?searchCriteria.sourceRefName=${enc(`refs/heads/${headBranch}`)}` +
        `&searchCriteria.targetRefName=${enc(`refs/heads/${baseRef}`)}&searchCriteria.status=active`
    )
    const value = asArray(asObj(r.json).value)
    return value.length > 0 ? asObj(value[0]) : null
  }

  /** Bearer for an Entra OAuth JWT; HTTP Basic (empty user) for a classic PAT. */
  private authHeader(): string {
    const isJwt = this.token.split('.').length === 3 && this.token.startsWith('eyJ')
    return isJwt ? `Bearer ${this.token}` : `Basic ${btoa(`:${this.token}`)}`
  }

  private headers(withBody: boolean): HeadersInit {
    const h: Record<string, string> = {
      Authorization: this.authHeader(),
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
    const sep = path.includes('?') ? '&' : '?'
    return providerCall({
      provider: 'azure',
      method,
      url: `${this.api}${path}${sep}api-version=${API_VERSION}`,
      headers: this.headers(opts?.body !== undefined),
      body: opts?.body,
      allow: opts?.allow,
      // ADO's `message` is a non-secret summary (the token is never echoed).
      errorDetail: (json) => {
        const message = jsonMessage(json)
        return message ? ` :: ${message}` : ''
      }
    })
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
