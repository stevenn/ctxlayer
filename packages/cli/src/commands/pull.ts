import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import pc from 'picocolors'
import type { SkillExportEntry, SkillExportResponse } from '@ctxlayer/shared'
import { authedGet } from '../auth/client'
import { skillsDir } from '../paths'

/**
 * Pull all published skills from ctxlayer and materialise them as
 * SKILL.md files under ~/.claude/skills/ctxlayer/<slug>/SKILL.md.
 *
 * Local subdirectories whose slug isn't in the export are pruned, so
 * un-publishing a skill in ctxlayer removes it locally on the next
 * pull. LF line endings forced regardless of OS to keep Claude Code
 * happy on Windows + Git from smearing CRLF on next checkout.
 */
export async function pullCommand(opts: { dryRun?: boolean }): Promise<void> {
  console.log('Fetching skill export …')
  const body = await authedGet<SkillExportResponse>('/cli/skills/export')
  const dir = skillsDir()

  if (opts.dryRun) {
    console.log(pc.yellow('dry-run:'), `would write ${body.skills.length} skills to ${dir}`)
    for (const s of body.skills) {
      console.log(' ', pc.cyan(s.slug))
    }
    return
  }

  await fs.mkdir(dir, { recursive: true })
  const existing = await listLocalSlugs(dir)
  const incoming = new Set(body.skills.map((s) => s.slug))

  let added = 0
  let updated = 0
  for (const entry of body.skills) {
    const slugDir = join(dir, entry.slug)
    const file = join(slugDir, 'SKILL.md')
    const content = renderSkillMd(entry)
    await fs.mkdir(slugDir, { recursive: true })
    const had = existing.has(entry.slug)
    await fs.writeFile(file, content, 'utf-8')
    if (had) updated++
    else added++
  }

  let pruned = 0
  for (const slug of existing) {
    if (incoming.has(slug)) continue
    await fs.rm(join(dir, slug), { recursive: true, force: true })
    pruned++
  }

  console.log(
    pc.green('✓'),
    `Pulled ${body.skills.length} skills (` +
      `${added} added, ${updated} updated, ${pruned} pruned` +
      `).`
  )
  console.log('  Materialised under', pc.cyan(dir))
}

function renderSkillMd(entry: SkillExportEntry): string {
  const fm =
    `---\n` +
    `name: ${entry.name}\n` +
    `description: ${yamlOneLine(entry.description)}\n` +
    `---\n`
  const managed = `<!-- Managed by @ctxlayer/cli. Edits will be overwritten on next pull. -->\n`
  const triggerPart = entry.triggerText.trim() ? `\n${entry.triggerText.trim()}\n` : ''
  const body = entry.bodyMd || '_empty skill_'
  // Force LF — Claude Code expects it; on Windows Git would otherwise
  // smear CRLF on the next checkout of the workspace.
  return `${fm}${managed}${triggerPart}\n${body}`.replace(/\r\n/g, '\n')
}

function yamlOneLine(s: string): string {
  // Quote if the value contains chars that would confuse YAML's
  // simple-scalar parser. Cheap heuristic; full YAML quoting is
  // overkill for a description string.
  if (/[:#\n"\\]/.test(s)) return JSON.stringify(s)
  return s
}

async function listLocalSlugs(dir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw err
  }
}
