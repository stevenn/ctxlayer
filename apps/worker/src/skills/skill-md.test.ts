import { describe, expect, it } from 'vitest'
import type { SkillExportEntry } from '@ctxlayer/shared'
import { renderSkillMd } from './skill-md'

const entry = (over: Partial<SkillExportEntry> = {}): SkillExportEntry => ({
  slug: 'sk-demo',
  name: 'sk-demo',
  description: 'When to use this skill',
  triggerText: '',
  bodyMd: '# Body\n\nDo the thing.',
  ...over
})

describe('renderSkillMd', () => {
  it('emits frontmatter + body, no provenance by default (MCP surface)', () => {
    const out = renderSkillMd(entry())
    expect(out).toBe(
      '---\nname: sk-demo\ndescription: When to use this skill\n---\n\n# Body\n\nDo the thing.'
    )
    expect(out).not.toContain('Exported from ctxlayer')
  })

  it('adds a provenance comment when opts.provenance (file download)', () => {
    const out = renderSkillMd(entry(), { provenance: true })
    expect(out).toContain('<!-- Exported from ctxlayer. -->')
    // provenance sits right after the closing frontmatter fence.
    expect(out.startsWith('---\nname: sk-demo\ndescription: When to use this skill\n---\n<!-- Exported from ctxlayer. -->\n')).toBe(true)
  })

  it('inserts the trigger paragraph before the body when present', () => {
    const out = renderSkillMd(entry({ triggerText: 'Use when X happens.' }))
    expect(out).toContain('---\n\nUse when X happens.\n\n# Body')
  })

  it('falls back to a placeholder for an empty body', () => {
    expect(renderSkillMd(entry({ bodyMd: '' }))).toContain('_empty skill_')
  })

  it('quotes a description that would confuse YAML', () => {
    const out = renderSkillMd(entry({ description: 'ratio a:b matters' }))
    expect(out).toContain('description: "ratio a:b matters"')
  })

  it('forces LF line endings only when opts.forceLf', () => {
    const crlf = entry({ bodyMd: 'line1\r\nline2' })
    expect(renderSkillMd(crlf)).toContain('line1\r\nline2')
    expect(renderSkillMd(crlf, { forceLf: true })).toContain('line1\nline2')
    expect(renderSkillMd(crlf, { forceLf: true })).not.toContain('\r\n')
  })
})
