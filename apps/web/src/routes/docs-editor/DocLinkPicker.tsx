import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { Alert, Modal, Stack, Text, TextInput } from '@mantine/core'
import { conceptPath, type DocSummary } from '@ctxlayer/shared'
import { fetchDocs } from '../../lib/api'
import { explain } from './helpers'

interface DocLinkPickerProps {
  currentDocId: string
  onClose: () => void
  onPick: (pick: { label: string; href: string }) => void
}

/**
 * The single, unified "Add link" picker — replaces both BlockNote's built-in
 * URL link button and the old doc-only picker. Search a doc (inserts its
 * OKF-native concept-path href) OR paste a URL (inserts it as an external
 * link). External URLs are first-class; doc links round-trip as OKF paths.
 */
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
  const url = asUrl(query)
  const filtered = useMemo(
    () =>
      (docs ?? []).filter((d) =>
        q.length === 0 ? true : d.title.toLowerCase().includes(q) || d.slug.toLowerCase().includes(q)
      ),
    [docs, q]
  )

  function pickDoc(d: DocSummary) {
    onPick({ label: d.title || d.slug, href: conceptPath(d.folder, d.slug) })
  }
  function pickUrl(href: string) {
    onPick({ label: href, href })
  }

  return (
    <Modal opened onClose={onClose} title="Add link" centered size="md">
      <Stack gap="md">
        <TextInput
          autoFocus
          aria-label="Search docs or paste a URL"
          placeholder="Search docs or paste a URL…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            if (url) pickUrl(url)
            else if (filtered[0]) pickDoc(filtered[0])
          }}
        />
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        {url && (
          <button type="button" onClick={() => pickUrl(url)} style={rowStyle}>
            <div style={{ fontWeight: 500 }}>🔗 Link to URL</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
              {url}
            </div>
          </button>
        )}
        {!docs && !error && <Text c="dimmed">Loading…</Text>}
        {docs && filtered.length === 0 && !url && (
          <Text c="dimmed" fz="sm">
            No docs match. Paste a URL to link externally.
          </Text>
        )}
        {filtered.length > 0 && (
          <Stack gap={4} style={{ maxHeight: 360, overflowY: 'auto' }}>
            {filtered.map((d) => (
              <button type="button" key={d.id} onClick={() => pickDoc(d)} style={rowStyle}>
                <div style={{ fontWeight: 500 }}>{d.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  {conceptPath(d.folder, d.slug)}
                </div>
              </button>
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  )
}

/** Treat the query as a URL when it carries a scheme (or a `www.` prefix). */
function asUrl(raw: string): string | null {
  const s = raw.trim()
  if (/^(https?:\/\/|mailto:)/i.test(s)) return s
  if (/^www\.[^\s]+\.[^\s]+/i.test(s)) return `https://${s}`
  return null
}

const rowStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text)',
  cursor: 'pointer'
}
