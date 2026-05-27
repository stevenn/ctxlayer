import { spawn } from 'node:child_process'
import { CtxlayerError } from '../errors'
import { DRAFTER_OUTPUT_SCHEMA, type DraftedSkill } from './output-schema'

/**
 * Locate `claude` on PATH. Spawns `claude --version`; returns null if
 * absent so the command can bail with a friendly install pointer.
 *
 * Async because spawning is the only reliable cross-platform check;
 * looking up PATH manually misses .cmd on Windows, etc.
 */
export async function locateClaude(): Promise<string | null> {
  try {
    const out = await runCapture('claude', ['--version'], '', 5_000)
    return out.code === 0 ? 'claude' : null
  } catch {
    return null
  }
}

interface ClaudeRunResult {
  draft: DraftedSkill
  envelope: ClaudeJsonEnvelope
}

interface ClaudeJsonEnvelope {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  total_cost_usd?: number
  duration_ms?: number
  num_turns?: number
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>
  // We also see top-level model_name in some envelopes; keep as
  // unknown rest.
  [k: string]: unknown
}

export interface ClaudeRunOptions {
  systemPrompt: string
  userPrompt: string
  budgetUsd?: number
  /**
   * Override the binary path (e.g. for testing). Defaults to `claude`.
   */
  binary?: string
}

/**
 * Run `claude -p --output-format json --json-schema=...` and parse
 * the envelope. Note: NOT --bare — that strips keychain auth, which
 * would break operators relying on their Claude subscription.
 */
export async function runClaudeDraft(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = [
    '-p',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(DRAFTER_OUTPUT_SCHEMA),
    '--system-prompt',
    opts.systemPrompt,
    '--tools',
    '',
    '--max-budget-usd',
    String(opts.budgetUsd ?? 0.5)
  ]
  const run = await runCapture(opts.binary ?? 'claude', args, opts.userPrompt, 5 * 60_000)
  if (run.code !== 0) {
    const tail = run.stderr.trim().split(/\r?\n/).slice(-3).join(' | ')
    throw new CtxlayerError(
      `claude exited with code ${run.code}${tail ? `: ${tail}` : ''}`,
      'claude_failed'
    )
  }

  let envelope: ClaudeJsonEnvelope
  try {
    envelope = JSON.parse(run.stdout) as ClaudeJsonEnvelope
  } catch {
    throw new CtxlayerError(
      'claude output was not valid JSON. Pass CTXLAYER_DEBUG=1 to see stderr.',
      'claude_bad_envelope'
    )
  }
  if (envelope.is_error) {
    throw new CtxlayerError(
      `claude returned an error: ${envelope.result ?? '(no detail)'}`,
      'claude_error'
    )
  }
  const resultStr = envelope.result ?? ''
  let draft: DraftedSkill
  try {
    draft = JSON.parse(resultStr) as DraftedSkill
  } catch {
    throw new CtxlayerError(
      'claude returned an envelope but `result` was not valid JSON ' +
        '(despite the supplied json-schema). Pass CTXLAYER_DEBUG=1 to inspect.',
      'claude_result_not_json'
    )
  }
  if (!draft.frontmatter || !draft.body) {
    throw new CtxlayerError(
      'claude returned JSON that is missing `frontmatter` or `body`.',
      'claude_result_incomplete'
    )
  }
  return { draft, envelope }
}

interface CaptureResult {
  code: number
  stdout: string
  stderr: string
}

function runCapture(
  cmd: string,
  args: string[],
  stdin: string,
  timeoutMs: number
): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* swallow */
      }
      reject(new CtxlayerError(`${cmd} timed out after ${timeoutMs}ms`, 'claude_timeout'))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    if (stdin) {
      child.stdin.end(stdin)
    } else {
      child.stdin.end()
    }
  })
}
