import { describe, it, expect } from 'vitest'
import {
  SERVER_INSTRUCTIONS,
  composeInstructions,
  INSTRUCTIONS_CLIENT_CAP,
  STATIC_INSTRUCTIONS_BUDGET,
  GUIDANCE_BUDGET
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
