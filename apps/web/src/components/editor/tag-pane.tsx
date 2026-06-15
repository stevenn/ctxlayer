import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, MultiSelect, Stack, TagsInput, Text } from '@mantine/core'
import type { DocTags, ProductRef, TeamRef } from '@ctxlayer/shared'
import { DOC_LIMITS, clampTags } from '@ctxlayer/shared'
import { fetchDocTags, fetchProducts, fetchTagVocab, fetchTeams, putDocTags } from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import { OkfBadge } from './okf-badge'

interface Props {
  docId: string
  canEdit: boolean
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
const SAVE_DEBOUNCE_MS = 700

/**
 * Compact tag editor for the doc editor's right rail. Reads the doc's tags +
 * the org's teams/products on mount; autosaves on change (debounced) like the
 * rest of the editor — no Save button. Free-form tags use a TagsInput: type to
 * see suggestions from the org-wide vocabulary, Enter / click to add. Tags are
 * verbatim human labels (NOT slugs) — they map 1:1 to OKF frontmatter `tags`.
 *
 * For non-editors we still render the section but lock the inputs — readers
 * can see how the doc is tagged without being able to change it.
 */
export function TagPane({ docId, canEdit }: Props) {
  const [teams, setTeams] = useState<TeamRef[] | null>(null)
  const [products, setProducts] = useState<ProductRef[] | null>(null)
  const [vocab, setVocab] = useState<string[]>([])
  const [original, setOriginal] = useState<DocTags | null>(null)
  const [draft, setDraft] = useState<DocTags | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  // Mount: fetch org-wide teams + products + this doc's tags in parallel.
  useEffect(() => {
    const ctrl = new AbortController()
    Promise.all([
      fetchTeams(ctrl.signal),
      fetchProducts(ctrl.signal),
      fetchDocTags(docId, ctrl.signal)
    ]).then(
      ([t, p, tags]) => {
        if (ctrl.signal.aborted) return
        setTeams(t)
        setProducts(p)
        setOriginal(tags)
        setDraft(tags)
      },
      (err) => {
        if (ctrl.signal.aborted) return
        setError(explain(err))
      }
    )
    return () => ctrl.abort()
  }, [docId])

  // Tag vocabulary for autocomplete — best-effort, never blocks tag editing.
  useEffect(() => {
    const ctrl = new AbortController()
    fetchTagVocab(ctrl.signal).then(
      (v) => {
        if (!ctrl.signal.aborted) setVocab(v)
      },
      () => {}
    )
    return () => ctrl.abort()
  }, [])

  const dirty = draft !== null && original !== null && !sameTags(draft, original)

  // Autosave: persist whenever the draft diverges from the last-saved value,
  // debounced so rapid edits (typing several tags, toggling chips) coalesce
  // into one PUT. Refs let the debounce timer + the unmount flush read the
  // latest draft/original without re-arming on every keystroke.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const originalRef = useRef(original)
  originalRef.current = original

  const flush = useCallback(async () => {
    const d = draftRef.current
    const o = originalRef.current
    if (!d || !o || sameTags(d, o)) return
    setStatus('saving')
    setError(null)
    try {
      await putDocTags(docId, d)
      setOriginal(d)
      setStatus('saved')
    } catch (err) {
      setError(explain(err))
      setStatus('error')
    }
  }, [docId])

  useEffect(() => {
    if (!canEdit || !dirty) return
    const t = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [canEdit, dirty, flush])

  // Flush a pending change before this pane unmounts or the doc switches, so a
  // fast edit-then-navigate doesn't lose the last keystroke. Fire-and-forget;
  // the PUT replaces tags wholesale so a redundant send is harmless.
  useEffect(() => {
    return () => {
      const d = draftRef.current
      const o = originalRef.current
      if (d && o && !sameTags(d, o)) void putDocTags(docId, d).catch(() => {})
    }
  }, [docId])

  if (!draft || !teams || !products) {
    return (
      <SectionLabel>
        {error ? (
          <Text c="red" fz="xs">
            {error}
          </Text>
        ) : (
          <Text c="dimmed" fz="xs">
            Loading tags…
          </Text>
        )}
      </SectionLabel>
    )
  }

  return (
    <Stack gap={8}>
      <MultiSelect
        label="Teams"
        data={teams.map((t) => ({ value: t.id, label: t.displayName }))}
        value={draft.teams}
        onChange={(v) => setDraft({ ...draft, teams: v })}
        disabled={!canEdit}
        searchable
        clearable
        size="xs"
        nothingFoundMessage={teams.length === 0 ? 'No teams yet — ask an admin' : 'No match'}
        styles={{ label: tagLabelStyle }}
      />

      <MultiSelect
        label="Products"
        data={products.map((p) => ({ value: p.id, label: p.displayName }))}
        value={draft.products}
        onChange={(v) => setDraft({ ...draft, products: v })}
        disabled={!canEdit}
        searchable
        clearable
        size="xs"
        nothingFoundMessage={products.length === 0 ? 'No products yet' : 'No match'}
        styles={{ label: tagLabelStyle }}
      />

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <div style={tagLabelStyle}>Tags</div>
          <OkfBadge field="tags" />
        </div>
        <TagsInput
          data={vocab}
          value={draft.tags}
          // TagsInput hands back the full list on every add/remove; clamp it
          // exactly like the server (trim, collapse, cap length + count, dedup
          // case-insensitively) so what we show matches what gets stored.
          onChange={(vals) => setDraft({ ...draft, tags: clampTags(vals) })}
          disabled={!canEdit}
          maxTags={DOC_LIMITS.tagCount}
          maxLength={DOC_LIMITS.tag}
          clearable={false}
          size="xs"
          placeholder={draft.tags.length === 0 ? 'e.g. customer research' : undefined}
          aria-label="Tags"
          comboboxProps={{ withinPortal: true }}
        />
      </div>

      {error && (
        <Alert color="red" variant="light" radius="sm">
          {error}
        </Alert>
      )}

      {canEdit && !error && (
        <Text c="dimmed" fz="xs" ta="right" style={{ minHeight: 16 }}>
          {dirty || status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''}
        </Text>
      )}
    </Stack>
  )
}

// ----- helpers + atoms ----------------------------------------------------

const tagLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-dim)'
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={tagLabelStyle}>{children}</div>
}

function sameTags(a: DocTags, b: DocTags): boolean {
  return sameSet(a.teams, b.teams) && sameSet(a.products, b.products) && sameSet(a.tags, b.tags)
}
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  for (const v of b) if (!sa.has(v)) return false
  return true
}

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'You do not have permission to change tags.'
  })
}
