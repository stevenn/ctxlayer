import { useCallback, useEffect, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  MultiSelect,
  Stack,
  Text,
  TextInput
} from '@mantine/core'
import type { DocTags, ProductRef, TeamRef } from '@ctxlayer/shared'
import { DOC_LIMITS } from '@ctxlayer/shared'
import { fetchDocTags, fetchProducts, fetchTeams, putDocTags } from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import { OkfBadge } from './okf-badge'

interface Props {
  docId: string
  canEdit: boolean
}

/**
 * Compact tag editor for the doc editor's right rail. Reads the
 * doc's tags + the org's teams/products on mount; saves on Save
 * click. Free-form tags are chips (lowercased + dashed at insert
 * time per the conventions in PLAN.md F).
 *
 * For non-editors we still render the section but lock the inputs
 * and hide the Save button — readers can see how the doc is tagged
 * without being able to change it.
 */
export function TagPane({ docId, canEdit }: Props) {
  const [teams, setTeams] = useState<TeamRef[] | null>(null)
  const [products, setProducts] = useState<ProductRef[] | null>(null)
  const [original, setOriginal] = useState<DocTags | null>(null)
  const [draft, setDraft] = useState<DocTags | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [busy, setBusy] = useState(false)
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

  const dirty = draft !== null && original !== null && !sameTags(draft, original)

  function addTag() {
    const cleaned = normaliseTag(tagInput)
    if (!cleaned || !draft) return
    // Case-insensitive dedup so "Billing" + "billing" don't both land, but
    // store the value as typed (tags are human labels, not slugs).
    if (draft.tags.some((t) => t.toLowerCase() === cleaned.toLowerCase())) {
      setTagInput('')
      return
    }
    setDraft({ ...draft, tags: [...draft.tags, cleaned] })
    setTagInput('')
  }
  function removeTag(tag: string) {
    if (!draft) return
    setDraft({ ...draft, tags: draft.tags.filter((t) => t !== tag) })
  }

  const onSave = useCallback(async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      await putDocTags(docId, draft)
      setOriginal(draft)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }, [docId, draft])

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
        disabled={!canEdit || busy}
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
        disabled={!canEdit || busy}
        searchable
        clearable
        size="xs"
        nothingFoundMessage={products.length === 0 ? 'No products yet' : 'No match'}
        styles={{ label: tagLabelStyle }}
      />

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={tagLabelStyle}>Tags</div>
          <OkfBadge field="tags" />
        </div>
        {canEdit && (
          <Group gap={4} mt={4}>
            <TextInput
              value={tagInput}
              onChange={(e) => setTagInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addTag()
                }
              }}
              aria-label="Add tag"
              placeholder="e.g. customer research"
              size="xs"
              style={{ flex: 1 }}
              disabled={busy}
            />
            <Button size="xs" variant="default" onClick={addTag} disabled={!tagInput.trim() || busy}>
              Add
            </Button>
          </Group>
        )}
        <Group gap={4} mt={6}>
          {draft.tags.length === 0 && (
            <Text c="dimmed" fz="xs">
              No tags
            </Text>
          )}
          {draft.tags.map((t) => (
            <Chip key={t} label={t} onRemove={canEdit ? () => removeTag(t) : undefined} />
          ))}
        </Group>
      </div>

      {error && (
        <Alert color="red" variant="light" radius="sm">
          {error}
        </Alert>
      )}

      {canEdit && (
        <Button
          size="xs"
          onClick={onSave}
          loading={busy}
          disabled={!dirty}
          fullWidth
          variant={dirty ? 'filled' : 'default'}
        >
          {dirty ? 'Save tags' : 'Tags saved'}
        </Button>
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

function Chip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px 2px 8px',
        borderRadius: 10,
        border: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-muted)',
        fontSize: 11
      }}
    >
      {label}
      {onRemove && (
        <ActionIcon
          variant="subtle"
          size="xs"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          style={{ marginRight: -4 }}
        >
          ×
        </ActionIcon>
      )}
    </span>
  )
}

// Free-form: trim + collapse internal whitespace, cap length. No slugging —
// tags are human-readable labels and map verbatim to OKF frontmatter `tags`.
// Same per-tag cap as the server (DOC_LIMITS.tag).
function normaliseTag(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, DOC_LIMITS.tag)
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
