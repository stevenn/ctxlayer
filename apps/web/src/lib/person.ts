import type { UserSummary } from '@ctxlayer/shared'

/**
 * Display label for a person: their name, else the local-part of their email,
 * else an em dash for "nobody".
 *
 * Lives in lib/ because three unrelated route folders need it (docs-list,
 * docs-editor, admin/skills). It used to be re-exported from the docs-list
 * ROUTE module, which made the editor and an admin page import a lazy-loaded
 * route chunk just to format a name.
 */
export function personLabel(u: UserSummary | null | undefined): string {
  if (!u) return '—'
  if (u.name && u.name.length > 0) return u.name
  const at = u.email.indexOf('@')
  return at > 0 ? u.email.slice(0, at) : u.email
}
