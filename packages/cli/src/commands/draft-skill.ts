import { createInterface } from 'node:readline/promises'
import pc from 'picocolors'
import { type DraftContextBundle, SLUG_PREFIX, slugifyBody } from '@ctxlayer/shared'
import { authedRequest } from '../auth/client'
import { loadCredentials } from '../auth/token-store'
import { CtxlayerError } from '../errors'
import { DRAFTER_PROMPT_VERSION, DRAFTER_SYSTEM_PROMPT } from '../drafter/system-prompt'
import { locateClaude, runClaudeDraft } from '../drafter/claude-runner'
import { markdownToBlocks } from '../drafter/markdown-to-blocks'

interface DraftSkillOpts {
  upstream: string
  // Additional upstreams to combine into one cross-upstream skill.
  withUpstreams?: string[]
  tool?: string
  prompt?: string
  noSave?: boolean
  // Self-imposed spend ceiling for the `claude -p` run (NOT your account
  // balance — a guardrail so one draft can't run away). Default 1.0.
  budgetUsd?: number
  // Model for the drafting run; omit to inherit your Claude Code default.
  model?: string
}

const DEFAULT_DRAFT_BUDGET_USD = 1.0

/**
 * Flow:
 *   1. Locate `claude` on PATH (friendly install pointer if missing).
 *   2. Load + refresh creds.
 *   3. Fetch /cli/skills/draft-context bundle (admin-gated).
 *   4. Assemble system + user prompt; shell `claude -p`.
 *   5. Parse the envelope's `result` as JSON (frontmatter + body).
 *   6. Render preview.
 *   7. Prompt save / abort.
 *   8. On save: POST /cli/skills with title + description + slug +
 *      drafterMeta + content (markdown → BlockNote blocks).
 */
export async function draftSkillCommand(opts: DraftSkillOpts): Promise<void> {
  const claudeBin = await locateClaude()
  if (!claudeBin) {
    throw new CtxlayerError(
      'Claude Code CLI not found on PATH.\n' +
        '  Install: https://claude.com/claude-code\n' +
        '  Or author the skill manually in the admin SPA.',
      'claude_missing'
    )
  }

  const creds = await loadCredentials()
  if (!creds) {
    throw new CtxlayerError(
      'Not logged in. Run `ctxlayer login --base-url <https://...>` first.',
      'not_logged_in'
    )
  }

  if (opts.budgetUsd !== undefined && (!Number.isFinite(opts.budgetUsd) || opts.budgetUsd <= 0)) {
    throw new CtxlayerError('--budget must be a positive number (USD).', 'bad_budget')
  }
  const budgetUsd = opts.budgetUsd ?? DEFAULT_DRAFT_BUDGET_USD

  // Anchor + any --with upstreams, deduped; sent as a comma list.
  const upstreams = [...new Set([opts.upstream, ...(opts.withUpstreams ?? [])])]
  console.log('Fetching draft-context bundle …')
  const bundle = await authedRequest<DraftContextBundle>('/cli/skills/draft-context', {
    method: 'GET',
    query: {
      upstreams: upstreams.join(','),
      tool: opts.tool,
      prompt: opts.prompt
    }
  })

  const slugList = bundle.upstreams.map((u) => u.slug).join(' + ')
  const focusName = bundle.upstreams.map((u) => u.focusTool?.name).find(Boolean)
  console.log(
    `Drafting with Claude (upstreams: ${pc.cyan(slugList)}` +
      (focusName ? `, tool: ${pc.cyan(focusName)}` : '') +
      `, model: ${pc.cyan(opts.model ?? 'default')}` +
      `, budget: ${pc.cyan(`$${budgetUsd}`)}` +
      ') …'
  )
  const userPrompt = buildUserPrompt(bundle)
  const { draft, envelope } = await runClaudeDraft({
    systemPrompt: DRAFTER_SYSTEM_PROMPT,
    userPrompt,
    binary: claudeBin,
    budgetUsd,
    model: opts.model
  })

  // Skill slugs are enforced to the `sk-` prefix at the create boundary.
  // Normalise the drafter's slug here so the previewed slug matches what's
  // posted and the create can't 400 on a bare slug.
  draft.frontmatter.slug = normalizeSkillSlug(draft.frontmatter.slug)

  renderPreview(draft)

  if (opts.noSave) {
    console.log(pc.yellow('--no-save:'), 'preview only, nothing posted.')
    return
  }

  const choice = await promptChoice('Save as draft? (s)ave / (a)bort:', ['s', 'a'])
  if (choice !== 's') {
    console.log('Aborted. No skill created.')
    return
  }

  const blocks = markdownToBlocks(draft.body)
  const drafterMeta = buildDrafterMeta(bundle, envelope, !!opts.prompt)

  interface CreateResult {
    id: string
    slug: string
    lintFindings?: Array<{
      kind: string
      reference: string
      upstreamSlug: string | null
      toolName: string | null
    }>
  }
  const res = await authedRequest<CreateResult>('/cli/skills', {
    method: 'POST',
    body: {
      slug: draft.frontmatter.slug,
      title: draft.frontmatter.title,
      description: draft.frontmatter.description,
      triggerText: draft.frontmatter.triggerText,
      status: 'draft',
      drafterMeta,
      content: { blocks }
    }
  })

  console.log(pc.green('✓'), `Saved as draft (slug: ${pc.cyan(res.slug)}).`)
  console.log('  Edit / publish:', pc.cyan(`${creds.baseUrl}/app/admin/skills/${res.id}/edit`))

  if (res.lintFindings && res.lintFindings.length > 0) {
    console.log()
    console.log(pc.yellow('⚠  Schema linter findings (warning only — the draft saved):'))
    for (const f of res.lintFindings) {
      if (f.kind === 'mangled_reference') {
        // Valid call, but the body hardcodes the install slug. toolName
        // carries the native name to switch to (portable across installs).
        console.log(
          `    - ${pc.cyan(f.reference)} hardcodes the upstream slug — use the native name ` +
            `${pc.cyan(f.toolName ?? '?')} and name the upstream in prose`
        )
      } else {
        const where = f.upstreamSlug
          ? `${f.upstreamSlug}${f.toolName ? `.${f.toolName}` : ''}`
          : f.reference
        console.log(
          `    - ${pc.cyan(f.reference)} (${f.kind}: ${where}) — not found on attached upstream`
        )
      }
    }
    console.log(pc.gray('  Review / fix in the SPA editor.'))
  }
}

// ----- prompt assembly --------------------------------------------------

function buildUserPrompt(bundle: DraftContextBundle): string {
  // Inline the bundle as JSON; the system prompt teaches Claude how to
  // interpret each section.
  const lines: string[] = [
    'Context bundle (JSON):',
    '```json',
    JSON.stringify(bundle, null, 2),
    '```',
    ''
  ]
  if (bundle.operatorPrompt) {
    lines.push(`Operator request: ${bundle.operatorPrompt}`)
  } else {
    lines.push('Operator request: (none — propose a useful skill from the context above)')
  }
  return lines.join('\n')
}

function buildDrafterMeta(
  bundle: DraftContextBundle,
  envelope: { modelUsage?: Record<string, unknown>; total_cost_usd?: number; duration_ms?: number },
  operatorPromptProvided: boolean
): Record<string, unknown> {
  const modelKey = envelope.modelUsage ? Object.keys(envelope.modelUsage)[0] : undefined
  const contextInputs: string[] = []
  if (bundle.upstreams.length > 1) contextInputs.push('multiUpstream')
  if (bundle.upstreams.some((u) => u.focusTool)) contextInputs.push('focusTool')
  if (bundle.upstreams.some((u) => u.allTools.length > 0)) contextInputs.push('allTools')
  if (bundle.relatedDocs.length > 0) contextInputs.push('rag')
  if (bundle.upstreams.some((u) => u.usageAggregates)) contextInputs.push('usage')
  if (bundle.styleSkills.length > 0) contextInputs.push('style')
  if (operatorPromptProvided) contextInputs.push('operatorPrompt')
  return {
    from: 'cli+claude-code',
    model: modelKey ?? 'unknown',
    promptVersion: DRAFTER_PROMPT_VERSION,
    contextInputs,
    operatorPromptProvided,
    durationMs: envelope.duration_ms,
    costUsd: envelope.total_cost_usd,
    draftedAt: Math.floor(Date.now() / 1000)
  }
}

/**
 * Coerce a drafter-supplied slug to the enforced `sk-<body>` shape: strip
 * any existing `sk-` so we don't double it, re-slugify the body (the model
 * may emit stray characters), then re-prefix and cap at the SkillSlug max.
 */
function normalizeSkillSlug(raw: string): string {
  const prefix = `${SLUG_PREFIX.skill}-`
  const body = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
  return `${prefix}${slugifyBody(body, 64 - prefix.length)}`
}

// ----- preview rendering -------------------------------------------------

function renderPreview(draft: {
  frontmatter: { slug: string; title: string; description: string; triggerText?: string }
  body: string
}): void {
  console.log()
  console.log(pc.bold(pc.gray('──── Draft preview ────')))
  console.log(pc.bold('Slug:       '), pc.cyan(draft.frontmatter.slug))
  console.log(pc.bold('Title:      '), draft.frontmatter.title)
  console.log(pc.bold('Description:'), draft.frontmatter.description)
  if (draft.frontmatter.triggerText) {
    console.log(pc.bold('Trigger:    '), draft.frontmatter.triggerText)
  }
  console.log(pc.bold(pc.gray('──── Body ────')))
  console.log(draft.body)
  console.log(pc.bold(pc.gray('──── ────── ────')))
  console.log()
}

// ----- prompt helper -----------------------------------------------------

async function promptChoice(message: string, choices: string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    while (true) {
      const ans = (await rl.question(`${message} `)).trim().toLowerCase()
      if (choices.includes(ans)) return ans
      console.log(`Please answer one of: ${choices.join(', ')}`)
    }
  } finally {
    rl.close()
  }
}
