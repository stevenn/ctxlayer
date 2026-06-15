/**
 * OKF reserved files: `index.md` (directory listing) and `log.md` (change
 * history). Generation for export + recognition/parsing for import. Both are
 * optional per spec; we generate a root index.md (with okf_version) and a root
 * log.md, and skip any reserved file on import (they're artifacts, not docs).
 */

import { parseFrontmatter } from '@ctxlayer/shared'

const RESERVED = new Set(['index.md', 'log.md'])

/** A reserved OKF file (index.md / log.md) at any directory level? */
export function isReservedFile(path: string): boolean {
  const base = (path.split('/').pop() ?? path).toLowerCase()
  return RESERVED.has(base)
}

/** Extract `okf_version` from a root index.md frontmatter block, if present. */
export function readOkfVersion(indexMd: string): string | null {
  const { raw } = parseFrontmatter(indexMd)
  if (!raw) return null
  const m = /^okf_version\s*:\s*["']?([^"'\n]+)/m.exec(raw)
  return m?.[1]?.trim() ?? null
}

export interface BundleConcept {
  /** Concept path relative to the bundle root, with `.md` (e.g. `api/auth.md`). */
  relPath: string
  title: string
  description: string | null
}

/** Root index.md: `okf_version` frontmatter + a contents list (progressive disclosure). */
export function generateIndexMd(concepts: BundleConcept[], okfVersion = '0.1'): string {
  const lines = ['---', `okf_version: "${okfVersion}"`, '---', '', '# Contents', '']
  for (const c of [...concepts].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const desc = c.description ? ` - ${c.description.replace(/\s+/g, ' ').trim()}` : ''
    lines.push(`* [${c.title}](${c.relPath})${desc}`)
  }
  return `${lines.join('\n')}\n`
}

/** A dated log entry; `date` is ISO `YYYY-MM-DD`. */
export interface LogEntry {
  date: string
  text: string
}

/** Root log.md: date-grouped entries, newest first, `## YYYY-MM-DD` headings. */
export function generateLogMd(entries: LogEntry[]): string {
  const byDate = new Map<string, string[]>()
  for (const e of entries) {
    const list = byDate.get(e.date) ?? []
    list.push(e.text)
    byDate.set(e.date, list)
  }
  const out: string[] = ['# Log', '']
  for (const date of [...byDate.keys()].sort().reverse()) {
    out.push(`## ${date}`, '')
    for (const text of byDate.get(date) ?? []) out.push(`* **Update**: ${text}`)
    out.push('')
  }
  return `${out.join('\n')}\n`
}
