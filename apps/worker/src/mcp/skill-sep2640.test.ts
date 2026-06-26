import { describe, it, expect } from 'vitest'
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js'
import { buildSkillIndex } from './skill-sep2640'

describe('buildSkillIndex', () => {
  it('emits the agentskills.io discovery schema + one skill-md entry per row', () => {
    const doc = buildSkillIndex([
      { slug: 'linear-practices', description: 'How we file Linear issues' },
      { slug: 'driverai-research', description: 'Driver research playbook' }
    ])
    expect(doc.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json')
    expect(doc.skills).toEqual([
      {
        name: 'linear-practices',
        type: 'skill-md',
        description: 'How we file Linear issues',
        url: 'skill://linear-practices/SKILL.md'
      },
      {
        name: 'driverai-research',
        type: 'skill-md',
        description: 'Driver research playbook',
        url: 'skill://driverai-research/SKILL.md'
      }
    ])
  })

  it('produces an empty skills array (not null) when no skills are published', () => {
    expect(buildSkillIndex([]).skills).toEqual([])
  })
})

// Regression guard: the body resource is registered as `skill://{slug}/SKILL.md`.
// An SDK upgrade that changed trailing-literal matching would silently break
// reads (template stops matching real URIs) or collide with index.json.
describe('skill:// URI template contract', () => {
  const t = new UriTemplate('skill://{slug}/SKILL.md')

  it('round-trips a flat slug', () => {
    expect(t.expand({ slug: 'linear-practices' })).toBe('skill://linear-practices/SKILL.md')
    expect(t.match('skill://linear-practices/SKILL.md')).toEqual({ slug: 'linear-practices' })
  })

  it('does not match the index.json discovery URI', () => {
    expect(t.match('skill://index.json')).toBeNull()
  })

  it('enforces the /SKILL.md trailing literal', () => {
    expect(t.match('skill://linear-practices/OTHER.md')).toBeNull()
  })
})
