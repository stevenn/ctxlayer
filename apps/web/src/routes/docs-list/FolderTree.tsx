import { useMemo } from 'react'
import { Button, Group, Menu, Text } from '@mantine/core'
import type { DocSummary, FolderTreeNode } from '@ctxlayer/shared'
import { clickableRow } from '../../lib/a11y'
import {
  buildTree,
  type FolderGroup,
  type FolderSelection,
  groupCodeDocsByRepo,
  type TreeNode
} from './helpers'

// ----- Folder tree sidebar -----------------------------------------------

export function FolderTree({
  group,
  rootLabel,
  folders,
  selected,
  onSelect,
  rootDocCount,
  manageable,
  onRename,
  onDelete
}: {
  group: FolderGroup
  rootLabel: string
  folders: FolderTreeNode[]
  selected: FolderSelection
  onSelect: (sel: FolderSelection) => void
  rootDocCount: number
  manageable: boolean
  onRename?: (path: string) => void
  onDelete?: (path: string, descendantDocCount: number) => void
}) {
  const tree = useMemo(
    () => buildTree(folders, rootDocCount, rootLabel),
    [folders, rootDocCount, rootLabel]
  )

  return (
    <aside
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '8px 6px',
        background: 'var(--bg-surface)'
      }}
    >
      <FolderNodeRow
        node={tree}
        depth={0}
        group={group}
        selected={selected}
        onSelect={onSelect}
        manageable={manageable}
        onRename={onRename}
        onDelete={onDelete}
      />
    </aside>
  )
}

// ----- Code Docs tree (grouped by repo) ----------------------------------

export function CodeDocsTree({
  codeDocs,
  selected,
  onSelect
}: {
  codeDocs: DocSummary[]
  selected: FolderSelection
  onSelect: (sel: FolderSelection) => void
}) {
  const repos = useMemo(() => groupCodeDocsByRepo(codeDocs), [codeDocs])

  return (
    <aside
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '8px 6px',
        background: 'var(--bg-surface)'
      }}
    >
      <Text
        fz={10}
        fw={600}
        c="dimmed"
        tt="uppercase"
        style={{ letterSpacing: '0.06em', padding: '2px 8px 6px' }}
      >
        Code Docs
      </Text>
      {repos.map((r) => (
        <FolderNodeRow
          key={r.sourceId}
          node={r.tree}
          depth={0}
          group="code"
          sourceId={r.sourceId}
          selected={selected}
          onSelect={onSelect}
          manageable={false}
        />
      ))}
    </aside>
  )
}

function FolderNodeRow({
  node,
  depth,
  group,
  sourceId,
  selected,
  onSelect,
  manageable,
  onRename,
  onDelete
}: {
  node: TreeNode
  depth: number
  group: FolderGroup
  // Repo scope for the whole subtree (code group only); undefined for home.
  sourceId?: string | null
  selected: FolderSelection
  onSelect: (sel: FolderSelection) => void
  manageable: boolean
  onRename?: (path: string) => void
  onDelete?: (path: string, descendantDocCount: number) => void
}) {
  const isActive =
    selected.group === group &&
    (selected.sourceId ?? null) === (sourceId ?? null) &&
    (node.path ?? null) === (selected.path ?? null)
  const isRoot = node.path === null

  return (
    <>
      <Group
        gap={4}
        wrap="nowrap"
        style={{
          padding: '4px 8px',
          paddingLeft: 8 + depth * 14,
          borderRadius: 4,
          cursor: 'pointer',
          background: isActive ? 'var(--bg-hover)' : undefined
        }}
        {...clickableRow(() => onSelect({ group, path: node.path, sourceId }))}
      >
        <Text fz="sm" style={{ flex: 1, minWidth: 0, fontWeight: isActive || isRoot ? 600 : 400 }}>
          {node.label}
          <Text component="span" fz="xs" c="dimmed" ml={6}>
            {node.docCount}
          </Text>
        </Text>
        {manageable && !isRoot && node.path && (
          <Menu shadow="md" position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={(e) => e.stopPropagation()}
                px={4}
              >
                ⋯
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => node.path && onRename?.(node.path)}>Rename…</Menu.Item>
              <Menu.Item
                color="red"
                onClick={() => node.path && onDelete?.(node.path, node.descendantDocCount)}
              >
                Delete…
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      {node.children.map((child) => (
        <FolderNodeRow
          key={child.path ?? '/'}
          node={child}
          depth={depth + 1}
          group={group}
          sourceId={sourceId}
          selected={selected}
          onSelect={onSelect}
          manageable={manageable}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </>
  )
}
