import { describe, it, expect } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../env'
import { registerSkillPrompts, skillPromptEntries } from './skill-mcp'

const skill = (slug: string, title = `Title of ${slug}`, description = `When to use ${slug}`) => ({
  slug,
  title,
  description
})

describe('skillPromptEntries', () => {
  it('maps slug → prompt name with title + description', () => {
    expect(skillPromptEntries([skill('sk-driver-research')])).toEqual([
      {
        name: 'sk-driver-research',
        title: 'Title of sk-driver-research',
        description: 'When to use sk-driver-research'
      }
    ])
  })

  it('skips slugs reserved by hand-registered prompts', () => {
    const entries = skillPromptEntries([skill('draft-skill'), skill('sk-ok')])
    expect(entries.map((e) => e.name)).toEqual(['sk-ok'])
  })
})

/**
 * Fake env whose DB serves `listPublishedSkills` (bare .all()) and returns
 * null for any bound point-read (`getSkillBySlug` inside the prompt
 * callback), so callback wiring can be exercised without R2.
 */
function fakeEnv(rows: unknown[], opts?: { listThrows?: boolean }): Env {
  return {
    DB: {
      prepare: () => ({
        all: async () => {
          if (opts?.listThrows) throw new Error('d1 down')
          return { results: rows }
        },
        bind: () => ({ first: async () => null })
      })
    }
  } as unknown as Env
}

type RegisteredPrompt = {
  name: string
  cfg: { title: string; description: string }
  cb: () => Promise<{ messages: Array<{ role: string; content: { text: string } }> }>
}

function fakeServer(opts?: { throwOn?: string }) {
  const prompts: RegisteredPrompt[] = []
  const server = {
    registerPrompt: (name: string, cfg: RegisteredPrompt['cfg'], cb: RegisteredPrompt['cb']) => {
      if (opts?.throwOn === name) throw new Error(`Prompt ${name} is already registered`)
      prompts.push({ name, cfg, cb })
    }
  } as unknown as McpServer
  return { server, prompts }
}

describe('registerSkillPrompts', () => {
  it('registers one prompt per published skill with the skill description', async () => {
    const { server, prompts } = fakeServer()
    await registerSkillPrompts(server, fakeEnv([skill('sk-a'), skill('sk-b')]), () => undefined)
    expect(prompts.map((p) => p.name)).toEqual(['sk-a', 'sk-b'])
    expect(prompts[0]!.cfg).toEqual({
      title: 'Title of sk-a',
      description: 'When to use sk-a'
    })
  })

  it('a single failed registration degrades that prompt only', async () => {
    const { server, prompts } = fakeServer({ throwOn: 'sk-a' })
    await registerSkillPrompts(server, fakeEnv([skill('sk-a'), skill('sk-b')]), () => undefined)
    expect(prompts.map((p) => p.name)).toEqual(['sk-b'])
  })

  it('a failed skill list registers nothing and does not throw', async () => {
    const { server, prompts } = fakeServer()
    await registerSkillPrompts(server, fakeEnv([], { listThrows: true }), () => undefined)
    expect(prompts).toEqual([])
  })

  it('the prompt callback returns a notice when the skill is no longer published', async () => {
    // fakeEnv's point-read returns null → loadPublishedSkillMarkdown → null.
    const { server, prompts } = fakeServer()
    await registerSkillPrompts(server, fakeEnv([skill('sk-gone')]), () => undefined)
    const result = await prompts[0]!.cb()
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]!.role).toBe('user')
    expect(result.messages[0]!.content.text).toContain('no longer available')
  })
})
