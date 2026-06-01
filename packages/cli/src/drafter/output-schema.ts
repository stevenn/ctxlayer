/**
 * JSON Schema fed to `claude -p --json-schema=...` so the model
 * returns a strictly-shaped envelope. Mirrors the worker-side
 * CreateSkillRequest insofar as the operator-confirmed fields go.
 *
 * SlugPattern is intentionally a bit looser than the worker's
 * SkillSlug to avoid the model emitting an invalid slug and forcing
 * a retry; the CLI normalises the slug to the enforced `sk-` prefix
 * before POST (see normalizeSkillSlug in draft-skill.ts) and the worker
 * re-validates.
 */
export const DRAFTER_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['frontmatter', 'body'],
  additionalProperties: false,
  properties: {
    frontmatter: {
      type: 'object',
      required: ['slug', 'title', 'description'],
      additionalProperties: false,
      properties: {
        slug: { type: 'string', minLength: 1, maxLength: 64 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', minLength: 1, maxLength: 500 },
        triggerText: { type: 'string', maxLength: 500 }
      }
    },
    body: { type: 'string', minLength: 1 }
  }
} as const

export interface DraftedSkill {
  frontmatter: {
    slug: string
    title: string
    description: string
    triggerText?: string
  }
  body: string
}
