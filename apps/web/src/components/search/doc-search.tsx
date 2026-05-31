import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Badge, Button, Group, Loader, Stack, Text, TextInput } from '@mantine/core'
import type { SearchDocGroup, SearchResponse, SuggestedFilter } from '@ctxlayer/shared'
import { ApiError, ApiSchemaError, searchDocs } from '../../lib/api'

type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching'; query: string }
  | { kind: 'done'; query: string; resp: SearchResponse }
  | { kind: 'error'; query: string; message: string }

/**
 * Standalone semantic search for the search home. Submit-driven (Enter /
 * the button). The query is embedded verbatim and searched across the
 * caller's full scope; the server's LLM only surfaces optional filter
 * suggestions, shown here as clickable chips that re-scope the search.
 */
export function SearchPanel() {
  const nav = useNavigate()
  const [input, setInput] = useState('')
  const [activeFilter, setActiveFilter] = useState<SuggestedFilter | null>(null)
  const [state, setState] = useState<SearchState>({ kind: 'idle' })
  const ctrlRef = useRef<AbortController | null>(null)

  const run = useCallback(async (raw: string, filter: SuggestedFilter | null) => {
    const query = raw.trim()
    ctrlRef.current?.abort()
    if (!query) {
      setState({ kind: 'idle' })
      return
    }
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setState({ kind: 'searching', query })
    const scope = filter
      ? filter.kind === 'team'
        ? { teams: [filter.id] }
        : { products: [filter.id] }
      : undefined
    try {
      const resp = await searchDocs({ query, scope }, ctrl.signal)
      if (!ctrl.signal.aborted) setState({ kind: 'done', query, resp })
    } catch (err) {
      if (ctrl.signal.aborted) return
      setState({ kind: 'error', query, message: explain(err) })
    }
  }, [])

  const applyFilter = (f: SuggestedFilter) => {
    setActiveFilter(f)
    void run(input, f)
  }
  const clearFilter = () => {
    setActiveFilter(null)
    void run(input, null)
  }
  const clearAll = () => {
    ctrlRef.current?.abort()
    setInput('')
    setActiveFilter(null)
    setState({ kind: 'idle' })
  }

  const openSection = (docId: string, anchor?: string) =>
    nav(`/app/docs/${docId}${anchor ? `?section=${encodeURIComponent(anchor)}` : ''}`)

  return (
    <Stack gap="md">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(input, activeFilter)
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
              <Button variant="subtle" size="compact-xs" onClick={clearAll}>
                Clear
              </Button>
            ) : null
          }
          rightSectionWidth={state.kind === 'searching' ? 36 : 64}
        />
      </form>

      {state.kind === 'idle' ? (
        <Text c="dimmed" fz="sm" ta="center" mt="lg">
          Search across every doc in your org — authored and git-synced.
        </Text>
      ) : (
        <SearchResults
          state={state}
          activeFilter={activeFilter}
          onApplyFilter={applyFilter}
          onClearFilter={clearFilter}
          onClearAll={clearAll}
          onOpen={openSection}
        />
      )}
    </Stack>
  )
}

function SearchResults({
  state,
  activeFilter,
  onApplyFilter,
  onClearFilter,
  onClearAll,
  onOpen
}: {
  state: Exclude<SearchState, { kind: 'idle' }>
  activeFilter: SuggestedFilter | null
  onApplyFilter: (f: SuggestedFilter) => void
  onClearFilter: () => void
  onClearAll: () => void
  onOpen: (docId: string, anchor?: string) => void
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
        <Button variant="default" onClick={onClearAll} w={120}>
          Clear
        </Button>
      </Stack>
    )
  }

  const { resp } = state
  const terms = significantWords(resp.interpretation.rewrittenQuery)
  return (
    <Stack gap="sm">
      <FilterBar
        resp={resp}
        activeFilter={activeFilter}
        onApply={onApplyFilter}
        onClear={onClearFilter}
      />
      {resp.results.length === 0 ? (
        <Text c="dimmed">
          No matches for “{state.query}”
          {activeFilter ? ` with the ${activeFilter.name} filter` : ''}. Try different wording.
        </Text>
      ) : (
        resp.results.map((g) => (
          <ResultCard key={g.docId} group={g} terms={terms} onOpen={onOpen} />
        ))
      )}
    </Stack>
  )
}

/** Active filter (removable) + the LLM's clickable filter suggestions. */
function FilterBar({
  resp,
  activeFilter,
  onApply,
  onClear
}: {
  resp: SearchResponse
  activeFilter: SuggestedFilter | null
  onApply: (f: SuggestedFilter) => void
  onClear: () => void
}) {
  const suggestions = (resp.interpretation.suggestedFilters ?? []).filter(
    (s) => !(activeFilter && activeFilter.kind === s.kind && activeFilter.id === s.id)
  )
  if (!activeFilter && suggestions.length === 0) return null
  return (
    <Group gap={6} align="center">
      {activeFilter && (
        <Button
          size="compact-xs"
          variant="light"
          color="blue"
          rightSection={<span aria-hidden>✕</span>}
          onClick={onClear}
          title="Remove filter"
        >
          {activeFilter.kind}: {activeFilter.name}
        </Button>
      )}
      {suggestions.length > 0 && (
        <Text fz="xs" c="dimmed">
          Filter by:
        </Text>
      )}
      {suggestions.map((s) => (
        <Badge
          key={`${s.kind}:${s.id}`}
          variant="light"
          color="grape"
          style={{ cursor: 'pointer' }}
          onClick={() => onApply(s)}
          title={`Narrow to ${s.kind} ${s.name}`}
        >
          + {s.name}
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

/** Significant words from the query, used to highlight snippet matches. */
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
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
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
