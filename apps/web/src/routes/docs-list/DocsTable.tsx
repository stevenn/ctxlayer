import { useMemo } from 'react'
import { Badge, Button, Group, Menu, Stack, Text, Tooltip } from '@mantine/core'
import type { DocSummary } from '@ctxlayer/shared'
import { clickableRow } from '../../lib/a11y'
import { filterDocs, type FolderGroup, formatRelative, isGitDoc, personLabel } from './helpers'

// ----- Docs table --------------------------------------------------------

export function DocsTable({
  docs,
  group,
  folder,
  sourceId,
  query,
  onOpen,
  onMove
}: {
  docs: DocSummary[]
  group: FolderGroup
  folder: string | null
  sourceId: string | null
  query: string
  onOpen: (id: string) => void
  onMove: (doc: DocSummary) => void
}) {
  // A non-empty query is a global "find a doc anywhere" — it searches the
  // whole library (both groups) and bypasses the folder filter. An empty
  // query is strict browse: docs of the selected group directly in the
  // selected folder (null path = that group's root). For the code group
  // the selection is also scoped to a repo (sourceId), but folder matching
  // stays exact — identical to the authored-doc browser — so the repo root
  // lists only its top-level docs, not the whole repo recursively.
  const scoped = useMemo(() => {
    if (query.trim()) return docs
    if (group === 'home') {
      return docs.filter((d) => !isGitDoc(d) && (d.folder ?? null) === folder)
    }
    return docs.filter((d) => {
      if (!isGitDoc(d)) return false
      if (sourceId && d.gitSourceId !== sourceId) return false
      return (d.folder ?? null) === folder
    })
  }, [docs, folder, sourceId, query, group])
  const filtered = useMemo(() => filterDocs(scoped, query), [scoped, query])

  const repoLabel =
    group === 'code' && sourceId
      ? (() => {
          const r = docs.find((d) => d.gitSourceId === sourceId)
          return r?.gitSourceName || r?.gitSourceSlug || 'repo'
        })()
      : null
  const where = folder ?? repoLabel ?? (group === 'code' ? 'Code Docs' : 'Home')
  if (filtered.length === 0) {
    return (
      <Text c="dimmed">
        {query ? `No docs match "${query}" across the library.` : `No docs in ${where} yet.`}
      </Text>
    )
  }
  return (
    <Stack gap={6}>
      <Text c="dimmed" fz="xs">
        {query
          ? `Showing ${filtered.length} of ${docs.length} matching "${query}" (whole library)`
          : `Showing ${filtered.length} in ${where}`}
      </Text>
      <table className="data-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Folder</th>
            <th>Created by</th>
            <th>Last edited by</th>
            <th style={{ textAlign: 'right' }}>Updated</th>
            <th style={{ width: 32 }} aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {filtered.map((d) => (
            <tr key={d.id} {...clickableRow(() => onOpen(d.id))}>
              <td>
                <Group gap={6} wrap="nowrap">
                  <span style={{ fontWeight: 500 }}>{d.title}</span>
                  {isGitDoc(d) && (
                    <Tooltip label="Synced from a git repo">
                      <Badge
                        color="grape"
                        variant="light"
                        size="xs"
                        leftSection={<span aria-hidden>⎇</span>}
                      >
                        git
                      </Badge>
                    </Tooltip>
                  )}
                  {d.lockedAt !== null && (
                    <Tooltip label={`Locked${d.lockedBy ? ` by ${personLabel(d.lockedBy)}` : ''}`}>
                      <Badge color="yellow" variant="light" size="xs">
                        locked
                      </Badge>
                    </Tooltip>
                  )}
                </Group>
                <div className="text-dim" style={{ fontSize: 12, marginTop: 2 }}>
                  {d.slug} · {d.kind}
                </div>
              </td>
              <td className="text-muted">
                {d.folder ? <code style={{ fontSize: 12 }}>{d.folder}</code> : '—'}
              </td>
              <td className="text-muted">{personLabel(d.createdBy)}</td>
              <td className="text-muted">{personLabel(d.updatedBy ?? d.createdBy)}</td>
              <td className="text-muted" style={{ textAlign: 'right' }}>
                {formatRelative(d.updatedAt)}
              </td>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation guard, not an interactive control — keeps a click on the actions menu from triggering the row's open-doc handler */}
              <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'right' }}>
                {/* Git docs are foldered by their repo path (sync-owned),
                    so "Move to folder" only applies to authored docs. */}
                {!isGitDoc(d) && (
                  <Menu shadow="md" position="bottom-end" withinPortal>
                    <Menu.Target>
                      <Button size="compact-xs" variant="subtle" px={6}>
                        ⋯
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={() => onMove(d)}>Move to folder…</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Stack>
  )
}
