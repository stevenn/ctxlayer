import type { GitProvider } from '@ctxlayer/shared'

/**
 * Parse a pasted repo URL into the fields a git source needs. Handles
 * the web URLs people copy from the address bar, including GitHub
 * `/tree/{branch}/{subpath}` links (which carry the branch + folder).
 *
 * GitHub is the fully-supported provider; gitlab/azure are parsed
 * best-effort so the form is ready when those land. An unknown host is
 * assumed to be self-hosted GitHub Enterprise (configurable base URL).
 */
export interface ParsedGitUrl {
  provider: GitProvider
  baseUrl: string | null // null = the provider's public host
  owner: string
  project: string // azure project (or gitlab full path); '' for github
  repo: string
  branch: string | null // from /tree/{branch}; null = not in the URL
  pathPrefix: string // subpath after the branch; '' if none
  slugSuggestion: string
}

export function parseGitUrl(input: string): ParsedGitUrl | null {
  const raw = input.trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase()
  const segs = u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
  if (segs.length < 2) return null

  // Azure DevOps: dev.azure.com/{org}/{project}/_git/{repo}
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
    const gi = segs.indexOf('_git')
    const repoSeg = segs[gi + 1]
    if (gi < 1 || !repoSeg) return null
    const repo = stripDotGit(repoSeg)
    return {
      provider: 'azure',
      baseUrl: host === 'dev.azure.com' ? null : `${u.protocol}//${u.host}`,
      owner: segs[0]!,
      project: segs.slice(1, gi).join('/'),
      repo,
      branch: null,
      pathPrefix: '',
      slugSuggestion: slugifyName(repo)
    }
  }

  let provider: GitProvider
  let baseUrl: string | null
  if (host === 'github.com' || host === 'www.github.com') {
    provider = 'github'
    baseUrl = null
  } else if (host === 'gitlab.com') {
    provider = 'gitlab'
    baseUrl = null
  } else if (host.includes('gitlab')) {
    provider = 'gitlab'
    baseUrl = `${u.protocol}//${u.host}`
  } else {
    // Unknown host → assume self-hosted GitHub Enterprise.
    provider = 'github'
    baseUrl = `${u.protocol}//${u.host}`
  }

  if (provider === 'gitlab') {
    // group(/subgroup)*/repo with optional /-/tree/{branch}/{subpath}
    const dashIdx = segs.indexOf('-')
    const projectSegs = (dashIdx >= 0 ? segs.slice(0, dashIdx) : segs).map(stripDotGit)
    if (projectSegs.length < 1) return null
    const repo = projectSegs[projectSegs.length - 1]!
    let branch: string | null = null
    let pathPrefix = ''
    if (dashIdx >= 0 && segs[dashIdx + 1] === 'tree') {
      branch = segs[dashIdx + 2] ?? null
      pathPrefix = segs.slice(dashIdx + 3).join('/')
    }
    return {
      provider,
      baseUrl,
      owner: '',
      project: projectSegs.join('/'),
      repo,
      branch,
      pathPrefix,
      slugSuggestion: slugifyName(repo)
    }
  }

  // GitHub (+ Enterprise): /{owner}/{repo}[/tree/{branch}/{subpath...}]
  const repo = stripDotGit(segs[1]!)
  let branch: string | null = null
  let pathPrefix = ''
  if (segs[2] === 'tree') {
    branch = segs[3] ?? null
    pathPrefix = segs.slice(4).join('/')
  }
  return {
    provider,
    baseUrl,
    owner: segs[0]!,
    project: '',
    repo,
    branch,
    pathPrefix,
    slugSuggestion: slugifyName(repo)
  }
}

function stripDotGit(s: string): string {
  return s.replace(/\.git$/i, '')
}

function slugifyName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
