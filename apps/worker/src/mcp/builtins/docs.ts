import { McpSearchResult } from '@ctxlayer/shared'
import { resolveUserScope } from '../../db/queries/doc-tags'
import { getDocByIdOrSlug } from '../../db/queries/docs'
import { SEARCH_K_DEFAULT, availableScopeFor, effectiveScope, searchDocs } from '../../rag/search'
import { BUILTIN_INPUT_SHAPES } from '../builtin-schemas'
import { docMarkdown } from '../doc-markdown'
import { errText } from '../tool-result'
import { defineBuiltin, jsonResult } from './types'

/** `get_doc` — one doc as markdown. Docs are open-read org-wide by design. */
export const getDoc = defineBuiltin({
  name: 'get_doc',
  inputShape: BUILTIN_INPUT_SHAPES.get_doc,
  run: async ({ id }, { env }) => {
    const doc = await getDocByIdOrSlug(env, id)
    if (!doc) return errText(`doc not found: ${id}`)
    const markdown = await docMarkdown(env, doc.id)
    return {
      content: [{ type: 'text', text: `# ${doc.title}\n\n${markdown || '_empty document_'}` }]
    }
  }
})

/** `search_docs` — hybrid retrieval over the doc library. */
export const searchDocsTool = defineBuiltin({
  name: 'search_docs',
  inputShape: BUILTIN_INPUT_SHAPES.search_docs,
  outputShape: McpSearchResult.shape,
  run: async ({ query, k, scope }, { env, user }) => {
    const userId = user?.userId
    if (!userId) return errText('not_signed_in')

    // Shared retrieval core (also backs REST /api/search): query
    // understanding → multi-query dense recall → cross-encoder rerank.
    const userScope = await resolveUserScope(env, userId)
    const effective = effectiveScope(scope, userScope)
    const available = await availableScopeFor(env, userScope)
    const { hits: matches } = await searchDocs(env, {
      query,
      k: k ?? SEARCH_K_DEFAULT,
      effective,
      available
    })

    // Typed against the shared MCP contract (see `McpSearchResult`).
    const body: McpSearchResult = { matches }
    return jsonResult(body)
  }
})
