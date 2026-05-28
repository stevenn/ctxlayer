import { spawn } from 'node:child_process'
import { CtxlayerError, isDebug } from '../errors'
import { type DraftedSkill } from './output-schema'

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
  // We deliberately do NOT pass --json-schema: in practice the model
  // silently drops the response when validation against a non-trivial
  // schema fails (empty `result` field with no is_error). The system
  // prompt already instructs JSON-only output and parseDraftResult()
  // recovers from common deviations (code fences, leading prose).
  const args = [
    '-p',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--system-prompt',
    opts.systemPrompt,
    '--tools',
    '',
    '--max-budget-usd',
    String(opts.budgetUsd ?? 0.5)
  ]
  const bin = opts.binary ?? 'claude'
  if (isDebug()) {
    console.error('[ctxlayer debug] spawning:', bin, args.map((a) => (a.length > 80 ? a.slice(0, 80) + '…' : a)))
    console.error('[ctxlayer debug] stdin bytes:', opts.userPrompt.length)
  }
  const run = await runCapture(bin, args, opts.userPrompt, 5 * 60_000)
  if (run.code !== 0) {
    if (isDebug()) {
      console.error('[ctxlayer debug] claude exit code:', run.code)
      console.error('[ctxlayer debug] claude stdout (first 4KB):\n', run.stdout.slice(0, 4096))
      console.error('[ctxlayer debug] claude stderr (first 4KB):\n', run.stderr.slice(0, 4096))
    }
    const tail = run.stderr.trim().split(/\r?\n/).slice(-3).join(' | ')
    const stdoutTail = run.stdout.trim().split(/\r?\n/).slice(-2).join(' | ')
    const detail =
      tail || stdoutTail || '(no output — re-run with CTXLAYER_DEBUG=1 for full streams)'
    throw new CtxlayerError(
      `claude exited with code ${run.code}: ${detail}`,
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
  if (isDebug()) {
    console.error('[ctxlayer debug] claude result length:', resultStr.length)
    console.error('[ctxlayer debug] claude result (first 2KB):\n', resultStr.slice(0, 2048))
  }
  const draft = parseDraftResult(resultStr)
  if (!draft) {
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

/**
 * Tries hard to coerce Claude's `result` string into a `{frontmatter, body}`
 * object. The model is supposed to honour `--json-schema` but in practice
 * it sometimes:
 *   - wraps the JSON in a ```json ... ``` code fence
 *   - prepends a short preamble ("Here's the skill:\n\n{...}")
 *   - appends trailing prose after the closing }
 * We attempt direct parse first, then strip code fences, then locate the
 * first balanced { ... } substring.
 */
function parseDraftResult(raw: string): DraftedSkill | null {
  const direct = tryParse(raw)
  if (direct) return direct
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
  const fenceParsed = tryParse(stripped)
  if (fenceParsed) return fenceParsed
  // Last-ditch: find the outermost JSON object by counting braces.
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return tryParse(raw.slice(start, i + 1))
    }
  }
  return null
}

function tryParse(s: string): DraftedSkill | null {
  if (!s) return null
  try {
    const v = JSON.parse(s) as DraftedSkill
    if (v && typeof v === 'object' && 'frontmatter' in v && 'body' in v) return v
    return null
  } catch {
    return null
  }
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
