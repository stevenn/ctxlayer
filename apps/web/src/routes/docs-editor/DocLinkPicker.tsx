import { useEffect, useState } from 'react'
import { Alert, Modal, Stack, Text, TextInput } from '@mantine/core'
import type { DocSummary } from '@ctxlayer/shared'
import { fetchDocs } from '../../lib/api'
import { explain } from './helpers'

interface DocLinkPickerProps {
  currentDocId: string
  onClose: () => void
  onPick: (pick: { label: string; href: string }) => void
}

export function DocLinkPicker({ currentDocId, onClose, onPick }: DocLinkPickerProps) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    fetchDocs(ctrl.signal).then(
      (rows) => {
        if (!ctrl.signal.aborted) setDocs(rows.filter((d) => d.id !== currentDocId))
      },
      (err) => {
        if (!ctrl.signal.aborted) setError(explain(err))
      }
    )
    return () => ctrl.abort()
  }, [currentDocId])

  const q = query.trim().toLowerCase()
  const filtered = (docs ?? []).filter((d) =>
    q.length === 0 ? true : d.title.toLowerCase().includes(q) || d.slug.toLowerCase().includes(q)
  )

  function pickDoc(d: DocSummary) {
    onPick({ label: d.slug, href: `/app/docs/${d.id}` })
  }

  return (
    <Modal opened onClose={onClose} title="Link to doc" centered size="md">
      <Stack gap="md">
        <TextInput
          autoFocus
          aria-label="Filter docs"
          placeholder="Filter by title or slug…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filtered[0]) {
              e.preventDefault()
              pickDoc(filtered[0])
            }
          }}
        />
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        {!docs && !error && <Text c="dimmed">Loading…</Text>}
        {docs && filtered.length === 0 && (
          <Text c="dimmed" fz="sm">
            No other docs match.
          </Text>
        )}
        {filtered.length > 0 && (
          <Stack gap={4} style={{ maxHeight: 360, overflowY: 'auto' }}>
            {filtered.map((d) => (
              <button
                type="button"
                key={d.id}
                onClick={() => pickDoc(d)}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text)',
                  cursor: 'pointer'
                }}
              >
                <div style={{ fontWeight: 500 }}>{d.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{d.slug}</div>
              </button>
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  )
}
