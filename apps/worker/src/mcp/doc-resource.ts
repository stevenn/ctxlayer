import type { Env } from '../env'
import { getDocByIdOrSlug, listDocs } from '../db/queries/docs'
import { docMarkdown } from './doc-markdown'
import { firstVar, type McpSurface } from './surface'

/**
 * Doc resources: `mcp://ctxlayer/docs/{id}`.
 *
 * The template's `list` exposes the available docs so MCP clients can
 * discover them without guessing ids; a read returns the doc rendered as
 * markdown. Docs are open-read org-wide by design (see CLAUDE.md), so there
 * is no per-user gate here.
 */
export function registerDocResource(surface: McpSurface, env: Env): void {
  const template = surface.resourceTemplate('mcp://ctxlayer/docs/{id}', async () => {
    const docs = await listDocs(env)
    return {
      resources: docs.map((d) => ({
        uri: `mcp://ctxlayer/docs/${d.id}`,
        name: d.title,
        description: d.doc_type ? `${d.slug} · ${d.doc_type}` : d.slug,
        mimeType: 'text/markdown'
      }))
    }
  })

  surface.registerResource(
    'doc',
    template,
    {
      title: 'Curated documents',
      description: 'All non-deleted docs in the ctxlayer library.'
    },
    async (uri, variables) => {
      const id = firstVar(variables.id)
      if (!id) return { contents: [{ uri: uri.toString(), text: 'missing doc id' }] }
      const doc = await getDocByIdOrSlug(env, id)
      if (!doc) return { contents: [{ uri: uri.toString(), text: `doc not found: ${id}` }] }
      const markdown = await docMarkdown(env, doc.id)
      return {
        contents: [
          { uri: uri.toString(), mimeType: 'text/markdown', text: `# ${doc.title}\n\n${markdown}` }
        ]
      }
    }
  )
}
