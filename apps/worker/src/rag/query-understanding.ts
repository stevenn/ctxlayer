/**
 * LLM query understanding for /api/search. Rewrites a natural-language
 * query into a keyword-rich form, proposes a couple of expansions to
 * widen recall, and extracts team/product filters by mapping names → ids
 * against the caller's reachable scope.
 *
 * Strictly best-effort: every failure mode (model error, invalid JSON,
 * timeout) falls back to the raw query with `llmUsed:false`, so search
 * never blocks or errors on the LLM. Successful interpretations are
 * cached in KV (scope-qualified) to absorb repeated identical queries.
 */

import type { Env } from '../env'

const QU_MODEL = '@cf/meta/llama-3.1-8b-instruct'
const QU_TIMEOUT_MS = 1500
const QU_MAX_TOKENS = 256
const QU_CACHE_TTL_SECONDS = 3600
const MAX_EXPANSIONS = 2
const MAX_TOPICS = 5

const SYSTEM_PROMPT = `You turn a user's natural-language documentation search into a structured query for a semantic search engine over an organization's internal docs. Respond with ONLY a JSON object — no prose, no markdown fences.

Shape:
{
  "rewrittenQuery": string,   // concise, keyword-rich restatement of the intent (a search query, not a sentence)
  "expansions": string[],     // 0-2 alternative phrasings or closely-related queries; [] if none would help
  "filters": {
    "teams": string[],        // team IDs, ONLY from the provided list, when the query clearly targets a team
    "products": string[],     // product IDs, ONLY from the provided list
    "topics": string[]        // short free-form topic keywords
  }
}

Rules: only emit team/product IDs that appear verbatim in the provided lists; never invent IDs; when unsure use []. Keep rewrittenQuery short. At most 2 expansions.`

export interface ScopeRef {
  id: string
  name: string
}
export interface AvailableScope {
  teams: ScopeRef[]
  products: ScopeRef[]
}

export interface QueryFilters {
  teams: string[]
  products: string[]
  topics: string[]
}

export interface QueryUnderstanding {
  rewrittenQuery: string
  expansions: string[]
  filters: QueryFilters
  llmUsed: boolean
}

function fallback(rawQuery: string): QueryUnderstanding {
  return {
    rewrittenQuery: rawQuery,
    expansions: [],
    filters: { teams: [], products: [], topics: [] },
    llmUsed: false
  }
}

export async function understandQuery(
  env: Env,
  rawQuery: string,
  scope: AvailableScope
): Promise<QueryUnderstanding> {
  const cacheKey = await cacheKeyFor(rawQuery, scope)
  try {
    const cached = await env.OAUTH_KV.get(cacheKey)
    if (cached) return JSON.parse(cached) as QueryUnderstanding
  } catch {
    // Cache read failure is non-fatal — fall through to the model.
  }

  let raw: string
  try {
    raw = await withTimeout(runModel(env, rawQuery, scope), QU_TIMEOUT_MS)
  } catch (err) {
    console.warn('query-understanding: model call failed', {
      err: err instanceof Error ? err.message : String(err)
    })
    return fallback(rawQuery)
  }

  const parsed = parseModelJson(raw, rawQuery, scope)
  if (!parsed) return fallback(rawQuery)

  try {
    await env.OAUTH_KV.put(cacheKey, JSON.stringify(parsed), {
      expirationTtl: QU_CACHE_TTL_SECONDS
    })
  } catch {
    // Cache write failure is non-fatal.
  }
  return parsed
}

async function runModel(env: Env, rawQuery: string, scope: AvailableScope): Promise<string> {
  const teamLines = scope.teams.map((t) => `${t.id} — ${t.name}`).join('\n') || '(none)'
  const productLines = scope.products.map((p) => `${p.id} — ${p.name}`).join('\n') || '(none)'
  const res = (await env.AI.run(QU_MODEL, {
    max_tokens: QU_MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Available teams (id — name):\n${teamLines}\n\n` +
          `Available products (id — name):\n${productLines}\n\n` +
          `User query: ${rawQuery}`
      }
    ]
  } as never)) as unknown as { response?: string }
  return res?.response ?? ''
}

function parseModelJson(
  raw: string,
  rawQuery: string,
  scope: AvailableScope
): QueryUnderstanding | null {
  const json = extractJson(raw)
  if (!json) return null
  let obj: Record<string, unknown>
  try {
    const v = JSON.parse(json)
    if (!v || typeof v !== 'object') return null
    obj = v as Record<string, unknown>
  } catch {
    return null
  }

  const rewrittenQuery =
    typeof obj.rewrittenQuery === 'string' && obj.rewrittenQuery.trim()
      ? obj.rewrittenQuery.trim()
      : rawQuery

  const expansions = strArray(obj.expansions)
    .map((e) => e.trim())
    .filter(Boolean)
    .slice(0, MAX_EXPANSIONS)

  const f =
    obj.filters && typeof obj.filters === 'object' ? (obj.filters as Record<string, unknown>) : {}
  const teamIds = new Set(scope.teams.map((t) => t.id))
  const productIds = new Set(scope.products.map((p) => p.id))
  const filters: QueryFilters = {
    teams: strArray(f.teams).filter((id) => teamIds.has(id)),
    products: strArray(f.products).filter((id) => productIds.has(id)),
    topics: strArray(f.topics)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_TOPICS)
  }

  return { rewrittenQuery, expansions, filters, llmUsed: true }
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Pull the first `{...}` object out of a model response (handles ```json fences). */
function extractJson(s: string): string | null {
  if (!s) return null
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced?.[1] ?? s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  return body.slice(start, end + 1)
}

/** Reject the model promise after `ms` so a slow call can't wedge a search. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** Scope-qualified cache key so two users with different reach don't share. */
async function cacheKeyFor(rawQuery: string, scope: AvailableScope): Promise<string> {
  const basis = JSON.stringify({
    q: rawQuery.trim().toLowerCase(),
    t: scope.teams.map((t) => t.id).sort(),
    p: scope.products.map((p) => p.id).sort()
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `qu:${hex}`
}
