/**
 * Shape of the JSON envelope the drafter prompt asks `claude -p` to
 * emit (the runner deliberately does NOT pass `--json-schema` — see
 * claude-runner.ts; the schema flag proved brittle, so the prompt
 * describes the shape and parseDraftResult validates leniently).
 * Mirrors the worker-side CreateSkillRequest insofar as the
 * operator-confirmed fields go. The CLI normalises the slug to the
 * enforced `sk-` prefix before POST (see normalizeSkillSlug in
 * draft-skill.ts) and the worker re-validates.
 */
export interface DraftedSkill {
  frontmatter: {
    slug: string
    title: string
    description: string
    triggerText?: string
  }
  body: string
}
