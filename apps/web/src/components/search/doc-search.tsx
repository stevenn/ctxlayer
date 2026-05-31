import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Badge, Button, Group, Loader, Stack, Text, TextInput } from '@mantine/core'
import type { SearchDocGroup, SearchResponse } from '@ctxlayer/shared'
import { ApiError, ApiSchemaError, searchDocs } from '../../lib/api'

type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching'; query: string }
  | { kind: 'done'; query: string; resp: SearchResponse }
  | { kind: 'error'; query: string; message: string }

/**
 * Hero RAG search for the docs homepage. Owns its own state and renders
 * either the semantic results (when a search has been run) or the
 * `children` browse view (when idle). Submit-driven — the LLM query-
 * understanding step makes per-keystroke searches too costly — so we
 * only fire on Enter / the Search button.
 */
export function DocSearch({ children }: { children: ReactNode }) {
  const nav = useNavigate()
  const [input, setInput] = useState('')
  const [state, setState] = useState<SearchState>({ kind: 'idle' })
  const ctrlRef = useRef<AbortController | null>(null)

  const run = useCallback(async (raw: string) => {
    const query = raw.trim()
    ctrlRef.current?.abort()
    if (!query) {
      setState({ kind: 'idle' })
      return
    }
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setState({ kind: 'searching', query })
    try {
      const resp = await searchDocs({ query }, ctrl.signal)
      if (!ctrl.signal.aborted) setState({ kind: 'done', query, resp })
    } catch (err) {
      if (ctrl.signal.aborted) return
      setState({ kind: 'error', query, message: explain(err) })
    }
  }, [])

  const clear = useCallback(() => {
    ctrlRef.current?.abort()
    setInput('')
    setState({ kind: 'idle' })
  }, [])

  function openSection(docId: string, anchor?: string) {
    const q = anchor ? `?section=${encodeURIComponent(anchor)}` : ''
    nav(`/app/docs/${docId}${q}`)
  }

  return (
    <Stack gap="md">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(input)
        }}
      >
        <TextInput
          size="md"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          placeholder="Search the docs — ask in plain language…"
          aria-label="Search docs"
          leftSection={<span aria-hidden>🔍</span>}
          rightSection={
            state.kind === 'searching' ? (
              <Loader size="xs" />
            ) : state.kind !== 'idle' ? (
              <Button variant="subtle" size="compact-xs" onClick={clear}>
                Clear
              </Button>
            ) : null
          }
          rightSectionWidth={state.kind === 'searching' ? 36 : 64}
        />
      </form>

      {state.kind === 'idle' ? (
        children
      ) : (
        <SearchResults state={state} onOpen={openSection} onClear={clear} />
      )}
    </Stack>
  )
}

function SearchResults({
  state,
  onOpen,
  onClear
}: {
  state: Exclude<SearchState, { kind: 'idle' }>
  onOpen: (docId: string, anchor?: string) => void
  onClear: () => void
}) {
  if (state.kind === 'searching') {
    return (
      <Group gap="xs" c="dimmed">
        <Loader size="xs" />
        <Text c="dimmed">Searching…</Text>
      </Group>
    )
  }
  if (state.kind === 'error') {
    return (
      <Stack gap="xs">
        <Alert color="red" variant="light" radius="sm">
          {state.message}
        </Alert>
        <Button variant="default" onClick={onClear} w={160}>
          ← Back to browse
        </Button>
      </Stack>
    )
  }

  const { resp } = state
  const terms = significantWords(resp.interpretation.rewrittenQuery)
  return (
    <Stack gap="sm">
      <Interpretation resp={resp} />
      {resp.results.length === 0 ? (
        <Text c="dimmed">
          No matches for “{state.query}”. Try different wording, or clear the search to browse.
        </Text>
      ) : (
        resp.results.map((g) => (
          <ResultCard key={g.docId} group={g} terms={terms} onOpen={onOpen} />
        ))
      )}
    </Stack>
  )
}

function Interpretation({ resp }: { resp: SearchResponse }) {
  const { interpretation: i } = resp
  if (!i.llmUsed) return null
  const chips: string[] = []
  if (i.filters?.teams?.length) chips.push(`teams: ${i.filters.teams.length}`)
  if (i.filters?.products?.length) chips.push(`products: ${i.filters.products.length}`)
  for (const t of i.filters?.topics ?? []) chips.push(t)
  return (
    <Group gap={6} align="center">
      <Text fz="xs" c="dimmed">
        Interpreted as “{i.rewrittenQuery}”
      </Text>
      {chips.map((c) => (
        <Badge key={c} size="xs" variant="light" color="blue">
          {c}
        </Badge>
      ))}
    </Group>
  )
}

function ResultCard({
  group,
  terms,
  onOpen
}: {
  group: SearchDocGroup
  terms: string[]
  onOpen: (docId: string, anchor?: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? group.sections : group.sections.slice(0, 2)
  const extra = group.sections.length - shown.length

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-surface)',
        padding: '12px 14px'
      }}
    >
      <button
        onClick={() => onOpen(group.docId)}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'pointer',
          color: 'var(--text)',
          fontWeight: 600,
          fontSize: 15,
          textAlign: 'left'
        }}
      >
        {group.title}
      </button>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{group.slug}</div>

      <Stack gap={8} mt={8}>
        {shown.map((s) => (
          <div key={s.chunkIdx} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            {s.headings.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 2 }}>
                {s.headings.join(' › ')}
              </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              <Highlighted text={s.snippet} terms={terms} />
            </div>
            <button
              onClick={() => onOpen(group.docId, s.anchor || undefined)}
              style={{
                background: 'transparent',
                border: 'none',
                padding: '4px 0 0',
                cursor: 'pointer',
                color: 'var(--accent)',
                fontSize: 12
              }}
            >
              Open at this section ›
            </button>
          </div>
        ))}
      </Stack>

      {extra > 0 && (
        <Button variant="subtle" size="compact-xs" mt={6} onClick={() => setExpanded(true)}>
          +{extra} more matching section{extra === 1 ? '' : 's'}
        </Button>
      )}
      {expanded && group.sections.length > 2 && (
        <Button variant="subtle" size="compact-xs" mt={6} onClick={() => setExpanded(false)}>
          Show fewer
        </Button>
      )}
    </div>
  )
}

// ----- snippet highlighting ----------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'how', 'does', 'what', 'are', 'you', 'your',
  'from', 'that', 'this', 'into', 'can', 'will', 'when', 'where', 'which',
  'was', 'has', 'have', 'about', 'why', 'who'
])

/** Significant words from the (rewritten) query, used to highlight snippets. */
function significantWords(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Wrap occurrences of `terms` in <mark>. Semantic-only matches may have
 * no literal overlap — then nothing is highlighted, which is expected
 * for RAG and is not "no match".
 */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>
  const re = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  // split with a single capture group interleaves [text, match, text, …];
  // the matches land at odd indices.
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>
      )}
    </>
  )
}

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 401)
    return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  return 'Could not reach the server.'
}
