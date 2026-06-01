import { z } from 'zod'

/**
 * Entity-type slug prefixes. Every slug an operator or agent sees is
 * `<prefix>-<body>`, so the entity type is legible at a glance and slugs
 * from different namespaces never read alike.
 *
 * Enforcement is applied to the create (and, for the mutable entities,
 * rename) REQUEST schemas via {@link prefixedSlug} — NOT to the read /
 * response shapes. Existing pre-prefix slugs are therefore grandfathered:
 * they keep validating on read because a prefixed slug is itself a valid
 * value under the permissive base schemas (DocSlug, OrgSlug, …).
 */
export const SLUG_PREFIX = {
  doc: 'doc',
  skill: 'sk',
  upstream: 'up',
  gitSource: 'repo',
  team: 'team',
  product: 'prod'
} as const
export type SlugEntity = keyof typeof SLUG_PREFIX

// Max total slug length per entity (prefix included). Mirrors the
// per-entity base schemas: DocSlug 96, SkillSlug 64, UpstreamSlug 24,
// GitSourceSlug 96, OrgSlug 96.
const SLUG_MAX: Record<SlugEntity, number> = {
  doc: 96,
  skill: 64,
  upstream: 24,
  gitSource: 96,
  team: 96,
  product: 96
}

/**
 * Canonical slug-body slugifier — the single implementation the worker,
 * SPA, and CLI all route through. Lowercases, strips diacritics, collapses
 * runs of non-alphanumerics to single dashes, trims edge dashes, caps
 * length, and falls back to `untitled` when nothing survives.
 */
export function slugifyBody(name: string, maxLen = 96): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      // Strip the combining diacritic marks NFKD just produced (é → e + ́),
      // which the next regex would otherwise turn into a dash.
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen) || 'untitled'
  )
}

/**
 * Suggest a full `<prefix>-<body>` slug for an entity from a human name.
 * The body is capped so the prefixed total fits the entity's max length.
 * Used for the live, editable slug preview in every create form.
 */
export function suggestSlug(entity: SlugEntity, name: string): string {
  const prefix = SLUG_PREFIX[entity]
  return `${prefix}-${slugifyBody(name, SLUG_MAX[entity] - prefix.length - 1)}`
}

/**
 * Zod schema for an enforced, prefixed slug INPUT (create / rename). The
 * body after `<prefix>-` is lowercase letters, digits and dashes with no
 * leading/trailing/double dash. Apply to REQUEST schemas only — read /
 * entity schemas keep their permissive base so pre-prefix rows validate.
 */
export function prefixedSlug(entity: SlugEntity) {
  const prefix = SLUG_PREFIX[entity]
  return z
    .string()
    .min(prefix.length + 2)
    .max(SLUG_MAX[entity])
    .regex(
      new RegExp(`^${prefix}-[a-z0-9]+(?:-[a-z0-9]+)*$`),
      `must be "${prefix}-" then lowercase letters, digits and dashes`
    )
}
