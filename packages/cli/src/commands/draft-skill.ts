import { createInterface } from 'node:readline/promises'
import pc from 'picocolors'
import type { DraftContextBundle } from '@ctxlayer/shared'
import { authedRequest } from '../auth/client'
import { loadCredentials } from '../auth/token-store'
import { CtxlayerError } from '../errors'
import {
  DRAFTER_PROMPT_VERSION,
  DRAFTER_SYSTEM_PROMPT
} from '../drafter/system-prompt'
import { locateClaude, runClaudeDraft } from '../drafter/claude-runner'
import { markdownToBlocks } from '../drafter/markdown-to-blocks'

interface DraftSkillOpts {
  upstream: string
  tool?: string
  prompt?: string
  noSave?: boolean
}

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

  console.log('Fetching draft-context bundle …')
  const bundle = await authedRequest<DraftContextBundle>('/cli/skills/draft-context', {
    method: 'GET',
    query: {
      upstream: opts.upstream,
      tool: opts.tool,
      prompt: opts.prompt
    }
  })

  console.log(
    `Drafting with Claude (focus: ${pc.cyan(bundle.upstream.slug)}` +
      (bundle.focusTool ? `, tool: ${pc.cyan(bundle.focusTool.name)}` : '') +
      ') …'
  )
  const userPrompt = buildUserPrompt(bundle)
  const { draft, envelope } = await runClaudeDraft({
    systemPrompt: DRAFTER_SYSTEM_PROMPT,
    userPrompt,
    binary: claudeBin,
    budgetUsd: 0.5
  })

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
    console.log(
      pc.yellow('⚠  Schema linter found references that don\'t exist on attached upstreams:')
    )
    for (const f of res.lintFindings) {
      const where = f.upstreamSlug
        ? `${f.upstreamSlug}${f.toolName ? `.${f.toolName}` : ''}`
        : f.reference
      console.log(`    - ${pc.cyan(f.reference)} (${f.kind}: ${where})`)
    }
    console.log(
      pc.gray(
        '  (Warning only — the draft saved successfully. Review in the SPA editor.)'
      )
    )
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
    lines.push(
      'Operator request: (none — propose a useful skill from the context above)'
    )
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
  if (bundle.focusTool) contextInputs.push('focusTool')
  if (bundle.allTools.length > 0) contextInputs.push('allTools')
  if (bundle.relatedDocs.length > 0) contextInputs.push('rag')
  if (bundle.usageAggregates) contextInputs.push('usage')
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
