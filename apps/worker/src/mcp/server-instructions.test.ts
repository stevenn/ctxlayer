import { describe, it, expect } from 'vitest'
import {
  SERVER_INSTRUCTIONS,
  composeInstructions,
  staticInstructions,
  guidanceBudget,
  INSTRUCTIONS_CLIENT_CAP,
  STATIC_INSTRUCTIONS_BUDGET,
  GUIDANCE_BUDGET,
  MAX_GATEWAY_ALIAS
} from './server-instructions'
import { upstreamGuidance, type UpstreamUserContext } from './catalogue-views'
import type { UpstreamServerRow } from '../db/queries/upstreams'
import type { SkillForUpstreamRow } from '../db/queries/skill-attachments'

const row = (id: string, slug: string): UpstreamServerRow => ({ id, slug }) as UpstreamServerRow
const skill = (slug: string): SkillForUpstreamRow =>
  ({ tool_name: '', slug, title: slug }) as SkillForUpstreamRow

// The shape of the reference deploy: two upstreams carrying three
// whole-upstream skills between them.
function realisticGuidance(): string {
  const ctx: UpstreamUserContext = {
    rows: [row('u1', 'up-driver'), row('u2', 'up-sentry')],
    skillsByUpstream: new Map([
      ['u1', [skill('sk-driver-ai-planning-skill'), skill('sk-driver-ai-research-skill')]],
      ['u2', [skill('sk-sentry-time-window-queries')]]
    ]),
    docsByUpstream: new Map()
  }
  return upstreamGuidance(ctx, GUIDANCE_BUDGET)
}

describe('server instructions size budget', () => {
  it('keeps the static block under its budget', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(STATIC_INSTRUCTIONS_BUDGET)
  })

  it('fits guidance + static under the client truncation cap', () => {
    const composed = composeInstructions(realisticGuidance())
    expect(composed.length).toBeLessThanOrEqual(INSTRUCTIONS_CLIENT_CAP)
  })

  it('fits under the cap for ANY attachment count (guidance collapses)', () => {
    // Way past any realistic org: 40 upstreams, 5 whole-upstream skills each.
    const rows = Array.from({ length: 40 }, (_, i) => row(`u${i}`, `up-server-number-${i}`))
    const skillsByUpstream = new Map(
      rows.map((r) => [
        r.id,
        Array.from({ length: 5 }, (_, j) => skill(`sk-${r.slug}-playbook-${j}`))
      ])
    )
    const guidance = upstreamGuidance(
      { rows, skillsByUpstream, docsByUpstream: new Map() },
      GUIDANCE_BUDGET
    )
    const composed = composeInstructions(guidance)
    expect(composed.length).toBeLessThanOrEqual(INSTRUCTIONS_CLIENT_CAP)
    // Some upstreams are named, the rest collapse to the structured pointer.
    expect(guidance).toContain('- `up-server-number-0`:')
    expect(guidance).toContain('check `list_upstreams.attached_skills`.')
  })
})

describe('gateway alias', () => {
  it('weaves the alias into the static block opening', () => {
    expect(staticInstructions('Yuki MCP')).toContain(
      'ctxlayer — the gateway your org calls "Yuki MCP" — is'
    )
  })

  it('is the plain static block for empty/blank alias', () => {
    expect(staticInstructions()).toBe(SERVER_INSTRUCTIONS)
    expect(staticInstructions('   ')).toBe(SERVER_INSTRUCTIONS)
  })

  it('stays under the static budget even at the max alias length', () => {
    const worst = staticInstructions('x'.repeat(MAX_GATEWAY_ALIAS + 100))
    expect(worst.length).toBeLessThanOrEqual(STATIC_INSTRUCTIONS_BUDGET)
  })

  it('fits alias + realistic guidance under the client cap (alias-aware budget)', () => {
    const alias = 'x'.repeat(MAX_GATEWAY_ALIAS)
    const ctx: UpstreamUserContext = {
      rows: [row('u1', 'up-driver'), row('u2', 'up-sentry')],
      skillsByUpstream: new Map([
        ['u1', [skill('sk-driver-ai-planning-skill'), skill('sk-driver-ai-research-skill')]],
        ['u2', [skill('sk-sentry-time-window-queries')]]
      ]),
      docsByUpstream: new Map()
    }
    const guidance = upstreamGuidance(ctx, guidanceBudget(alias))
    expect(composeInstructions(guidance, alias).length).toBeLessThanOrEqual(
      INSTRUCTIONS_CLIENT_CAP
    )
  })
})

describe('composeInstructions', () => {
  it('is the bare static block when the user has no attachments', () => {
    expect(composeInstructions('')).toBe(SERVER_INSTRUCTIONS)
  })

  it('puts guidance BEFORE the static block', () => {
    const guidance = realisticGuidance()
    const composed = composeInstructions(guidance)
    expect(composed.startsWith(guidance)).toBe(true)
    expect(composed.endsWith(SERVER_INSTRUCTIONS)).toBe(true)
    // The playbook lines must sit inside the client-visible window even
    // if a client cuts at the cap.
    expect(composed.indexOf('sk-driver-ai-planning-skill')).toBeLessThan(
      INSTRUCTIONS_CLIENT_CAP
    )
  })
})
