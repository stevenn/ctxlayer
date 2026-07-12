/**
 * Drafter guidance + MCP-prompt assembly for the in-app `/draft-skill`
 * flow. No server-side LLM: the prompt hands the *connected agent* this
 * org's context bundle (buildDraftContext) plus the drafting guidance, and
 * the agent persists its draft through the `save_draft_skill` tool. The
 * agent the user already pays for does the generation — the MCP-native
 * replacement for the CLI's `claude -p` path.
 *
 * The guidance mirrors the CLI drafter (v4) — what a skill is, the body
 * shape, the native-names rule — but its OUTPUT contract differs: instead
 * of returning a JSON envelope, the agent calls `save_draft_skill`.
 */

import type { DraftContextBundle } from '@ctxlayer/shared'

export const DRAFTER_PROMPT_VERSION = 'v4'

const DRAFTER_GUIDANCE = `You are drafting a "skill" for ctxlayer — an org-aware operating manual the agent loads on demand when working with one or more MCP upstreams (e.g. Linear, Datadog, Azure DevOps — or a combination).

A SKILL is a short, declarative playbook the agent reads to understand *this org's conventions* for a given tool. It is NOT a generic tool reference (the schema is already visible to the agent).

The JSON context bundle below has these sections:
  upstreams      — ONE OR MORE MCP upstreams. Each has: name + slug + transport, an \`allTools\` catalogue, an optional \`focusTool\` (schema for a specific tool), and usage.
  relatedDocs    — org docs related to the upstream(s), if any
  styleSkills    — 1-2 existing published skills as house-style refs
  operatorPrompt — freeform request from the operator (if any)

Body guidance:
- Lead with a short paragraph naming the scenario and the outcome.
- Then a numbered list of concrete steps (call tool X with these args, then tool Y with these args).
- Reference attached tools by their \`name\` field from the bundle (the native upstream tool name) in backticks — e.g. \`wit_work_item\`, \`repo_file\` — and name the owning upstream once in prose (e.g. "via the ADO upstream"). Do NOT use the \`mangledName\` / \`<slug>__tool\` form: it hardcodes this install's slug into the body and breaks the skill if the upstream is re-registered or reused on another install. The agent resolves the native name to the callable form at run time.
- When the bundle has MORE THAN ONE upstream, design a SINGLE cohesive workflow that weaves their tools together — not two parallel sections. Name each upstream in prose so the agent knows which server a tool belongs to.
- Include org-specific conventions you can derive from styleSkills or operatorPrompt (team IDs, labels, status names).
- Keep the body under 500 lines. Brevity > completeness. Do NOT restate the tool schema. Do NOT invent tools/arguments not in some upstream's allTools or focusTool.

When you have drafted the skill, DO NOT print it as your final answer — CALL the \`save_draft_skill\` tool with:
  - title        — human display label (40-100 chars)
  - description  — one-line "when to use" trigger
  - body         — the markdown body
  - triggerText  — (optional) extra "when X" hints
  - slug         — (optional) sk-<lowercase-hyphen> derived from the title
  - upstreams    — the upstream slugs this skill uses, from the bundle (e.g. ["up-ado","up-driver"])
It saves as a PRIVATE draft owned by you; you can then refine and share it from /app/skills.

To REVISE a skill instead of creating a new one — whether one you just saved in this conversation or an existing skill of yours the user asked you to edit — call \`save_draft_skill\` again with its \`skillId\` (from the earlier save result) or the same \`slug\`. That writes a NEW VERSION of that skill (its history is preserved) rather than a duplicate. Editing a skill that is already published pushes the change live to the org.`

export interface DraftPromptResult {
  // The MCP SDK's GetPromptResult carries an open index signature (for
  // `_meta` + forward-compat); mirror it so our results stay assignable.
  [key: string]: unknown
  description?: string
  messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>
}

/**
 * A single-user-message prompt result — used for the not-signed-in /
 * context-build-failed notices the `/draft-skill` prompt returns.
 */
export function draftPromptNotice(text: string): DraftPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] }
}

/**
 * The drafter guidance + inlined context bundle + operator request as a single
 * text block. Shared by BOTH entry points so they stay identical: the
 * `/draft-skill` MCP prompt (wraps it in a user message) and the `draft_skill`
 * TOOL (returns it as tool content — the client-agnostic entry, since not every
 * MCP client renders prompts). Either way the agent reads it, drafts, and calls
 * `save_draft_skill`.
 */
export function buildDraftSkillText(bundle: DraftContextBundle): string {
  return [
    DRAFTER_GUIDANCE,
    '',
    'Context bundle (JSON):',
    '```json',
    JSON.stringify(bundle, null, 2),
    '```',
    '',
    bundle.operatorPrompt
      ? `Operator request: ${bundle.operatorPrompt}`
      : 'Operator request: (none — propose a useful skill from the context above)'
  ].join('\n')
}

/**
 * Build the MCP `/draft-skill` prompt output: one user message carrying the
 * shared drafter text. Returned to the connected agent, which drafts + calls
 * `save_draft_skill`.
 */
export function buildDraftSkillMessages(bundle: DraftContextBundle): DraftPromptResult {
  return {
    description: `Draft a ctxlayer skill for ${bundle.upstreams.map((u) => u.slug).join(' + ')}`,
    messages: [{ role: 'user', content: { type: 'text', text: buildDraftSkillText(bundle) } }]
  }
}
