/**
 * Per-session MCP server, extending `McpAgent` from the agents SDK.
 *
 * Built-in tools (M2c B2):
 *   - whoami              — diagnostic; returns the session's user props
 *   - list_my_context     — teams + products + accessibleUpstreams + default scope
 *   - list_upstreams      — empty until M4 ships the proxy layer
 *   - get_doc(id)         — read R2 snapshot → markdown
 *   - search_docs(query, k?, scope?) — embed query → Vectorize → scope-filter
 *
 * Per-request props (set by `provider.completeAuthorization` in the
 * IdP callback) arrive on `this.props` — see `Env.McpProps`.
 */

import { McpAgent } from 'agents/mcp'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Env, McpProps } from '../env'
import { getDocById, listDocs } from '../db/queries/docs'
import { resolveUserScope } from '../db/queries/doc-tags'
import { readSnapshot } from '../storage/docs-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { embed } from '../rag/embedder'
import type { ChunkMetadata } from '../rag/index'
import { UpstreamProxyRegistry } from './tools-proxy'

const SEARCH_K_DEFAULT = 8
const SEARCH_K_MAX = 50
// Overshoot the topK so post-filter has headroom when many chunks
// don't match the user's scope. Cap at Vectorize's max (currently 100).
const SEARCH_OVERSHOOT = 3
const VECTORIZE_TOPK_MAX = 100

export class McpSessionDO extends McpAgent<Env, undefined, McpProps> {
  server = new McpServer({
    name: 'ctxlayer',
    version: '0.1.0'
  })

  private upstreamProxy: UpstreamProxyRegistry | null = null

  async init(): Promise<void> {
    this.server.registerTool(
      'whoami',
      {
        title: 'Who am I?',
        description: 'Returns the user props attached to this MCP session by ctxlayer.'
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify(this.props ?? null, null, 2) }]
      })
    )

    this.server.registerTool(
      'list_my_context',
      {
        title: 'List my context',
        description:
          'Returns the teams + products the caller belongs to (transitively via team membership), the accessible upstream MCP servers, and the default search scope that `search_docs` will use when no scope is supplied.'
      },
      async () => {
        const userId = this.props?.userId
        if (!userId) return errText('not_signed_in')
        const [scope, accessibleUpstreams] = await Promise.all([
          resolveUserScope(this.env, userId),
          UpstreamProxyRegistry.accessibleSlugs(this.env, userId)
        ])
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  teams: scope.teams,
                  products: scope.products,
                  accessibleUpstreams,
                  defaultScope: scope
                },
                null,
                2
              )
            }
          ]
        }
      }
    )

    this.server.registerTool(
      'list_upstreams',
      {
        title: 'List upstreams',
        description:
          'Lists the upstream MCP servers visible to the caller, with connected state, transport, and cached tool count. Disconnected upstreams point the user at /upstreams to paste a token.'
      },
      async () => {
        const userId = this.props?.userId
        if (!userId) return errText('not_signed_in')
        const entries = await UpstreamProxyRegistry.listUpstreamsForUser(this.env, userId)
        return {
          content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }]
        }
      }
    )

    this.server.registerTool(
      'get_doc',
      {
        title: 'Get document',
        description: 'Returns the markdown for a doc by id.',
        inputSchema: { id: z.string().min(1) }
      },
      async ({ id }) => {
        const doc = await getDocById(this.env, id)
        if (!doc) return errText(`doc not found: ${id}`)
        const content = await readSnapshot(this.env, id)
        const markdown = content ? renderBlocksToMarkdown(content.blocks) : ''
        return {
          content: [
            {
              type: 'text',
              text: `# ${doc.title}\n\n${markdown || '_empty document_'}`
            }
          ]
        }
      }
    )

    this.server.registerTool(
      'search_docs',
      {
        title: 'Search docs',
        description:
          'Semantic search over the org-curated doc library. Defaults to the caller\'s teams + products + globally-tagged docs. Pass `scope: "all"` to remove the filter, or `scope: { teams: [...], products: [...] }` to intersect with the caller\'s reachable set (no escalation).',
        inputSchema: {
          query: z.string().min(1),
          k: z.number().int().min(1).max(SEARCH_K_MAX).optional(),
          scope: z
            .union([
              z.literal('all'),
              z.object({
                teams: z.array(z.string()).optional(),
                products: z.array(z.string()).optional()
              })
            ])
            .optional()
        }
      },
      async ({ query, k, scope }) => {
        const userId = this.props?.userId
        if (!userId) return errText('not_signed_in')
        const limit = k ?? SEARCH_K_DEFAULT

        // Embed the query (one-element batch).
        const { vectors } = await embed(this.env, [query])
        const qvec = vectors[0]
        if (!qvec) return errText('embedding_failed')

        // Resolve the caller's effective scope.
        const userScope = await resolveUserScope(this.env, userId)
        const effective = effectiveScope(scope, userScope)

        // Overshoot topK to give post-filter room, capped at Vectorize's max.
        const topK = Math.min(limit * SEARCH_OVERSHOOT, VECTORIZE_TOPK_MAX)
        const result = await this.env.DOCS_INDEX.query(qvec, {
          topK,
          returnMetadata: 'all'
        })

        const matches = (result.matches ?? [])
          .map((m) => ({ ...m, metadata: m.metadata as unknown as ChunkMetadata }))
          .filter((m) => passesScope(m.metadata, effective))
          .slice(0, limit)
          .map((m) => ({
            docId: m.metadata.docId,
            chunkIdx: m.metadata.chunkIdx,
            title: m.metadata.title,
            headings: m.metadata.headings,
            score: m.score,
            snippet: truncate(m.metadata.text, 600)
          }))

        return {
          content: [{ type: 'text', text: JSON.stringify({ matches }, null, 2) }]
        }
      }
    )

    // ----- doc resources: mcp://ctxlayer/docs/{id} -----
    // The MCP `ResourceTemplate` lets the SDK expand `{id}` into the
    // calling URI, and our `list` callback exposes the available
    // resources so MCP clients can discover docs without guessing
    // IDs. Per-doc reads stream the snapshot rendered as markdown.
    const template = new ResourceTemplate('mcp://ctxlayer/docs/{id}', {
      list: async () => {
        const docs = await listDocs(this.env)
        return {
          resources: docs.map((d) => ({
            uri: `mcp://ctxlayer/docs/${d.id}`,
            name: d.title,
            description: `${d.slug} (${d.kind})`,
            mimeType: 'text/markdown'
          }))
        }
      }
    })

    // Hydrate proxied upstream tools alongside the built-ins. Best-effort:
    // a failure here must not block built-ins (search_docs / get_doc) from
    // serving. Each upstream's own listTools/callTool errors are caught
    // inside the registry; we only need to guard the enumeration itself.
    const userId = this.props?.userId
    if (userId) {
      try {
        this.upstreamProxy = new UpstreamProxyRegistry(this.env, userId)
        await this.upstreamProxy.init(this.server)
      } catch (err) {
        console.error('upstream proxy init failed:', err)
        this.upstreamProxy = null
      }
    }

    this.server.registerResource(
      'doc',
      template,
      {
        title: 'Curated documents',
        description: 'All non-deleted docs in the ctxlayer library.'
      },
      async (uri: URL, variables: { id?: string | string[] }) => {
        const idVar = variables.id
        const id = Array.isArray(idVar) ? idVar[0] : idVar
        if (!id) {
          return { contents: [{ uri: uri.toString(), text: 'missing doc id' }] }
        }
        const doc = await getDocById(this.env, id)
        if (!doc) {
          return { contents: [{ uri: uri.toString(), text: `doc not found: ${id}` }] }
        }
        const content = await readSnapshot(this.env, id)
        const markdown = content ? renderBlocksToMarkdown(content.blocks) : ''
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'text/markdown',
              text: `# ${doc.title}\n\n${markdown}`
            }
          ]
        }
      }
    )
  }
}

// ----- helpers ------------------------------------------------------------

interface EffectiveScope {
  teams: string[]
  products: string[]
  includeGlobal: boolean
  /** When true, skip all metadata filtering. */
  all: boolean
}

function effectiveScope(
  scope: 'all' | { teams?: string[]; products?: string[] } | undefined,
  user: { teams: string[]; products: string[] }
): EffectiveScope {
  if (scope === 'all') return { teams: [], products: [], includeGlobal: true, all: true }
  if (!scope) {
    return { teams: user.teams, products: user.products, includeGlobal: true, all: false }
  }
  // Intersect supplied scope with user's reachable set so a caller
  // can't escalate. Asked but not allowed → silently dropped.
  const teams = (scope.teams ?? user.teams).filter((t) => user.teams.includes(t))
  const products = (scope.products ?? user.products).filter((p) => user.products.includes(p))
  return { teams, products, includeGlobal: true, all: false }
}

function passesScope(m: ChunkMetadata, scope: EffectiveScope): boolean {
  if (scope.all) return true
  if (scope.includeGlobal && m.is_global) return true
  if (m.tag_teams.some((t) => scope.teams.includes(t))) return true
  if (m.tag_products.some((p) => scope.products.includes(p))) return true
  return false
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function errText(msg: string) {
  return { isError: true, content: [{ type: 'text' as const, text: msg }] }
}

