import { type MouseEvent, useCallback, useMemo, useState } from 'react'
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

// Per-node collapse state, persisted so a tamed tree stays tamed across
// reloads + navigation. Keys are `${group}:${sourceId}:${path}` (see nodeKey).
function useCollapsed(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  const toggle = useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]))
        } catch {
          /* private mode / quota — collapse just won't persist */
        }
        return next
      })
    },
    [storageKey]
  )
  return { collapsed, toggle }
}

function nodeKey(group: FolderGroup, sourceId: string | null | undefined, path: string | null) {
  return `${group}:${sourceId ?? ''}:${path ?? '/'}`
}

interface CollapseCtl {
  collapsed: Set<string>
  toggle: (key: string) => void
}

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
  const collapse = useCollapsed('ctxlayer.docTree.collapsed.home')

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
        collapse={collapse}
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
  // Code docs collapse per repo — each repo is a depth-0 node, so toggling it
  // hides its whole subtree. Shared state across all repos.
  const collapse = useCollapsed('ctxlayer.docTree.collapsed.code')

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
          collapse={collapse}
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
  collapse,
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
  collapse: CollapseCtl
  manageable: boolean
  onRename?: (path: string) => void
  onDelete?: (path: string, descendantDocCount: number) => void
}) {
  const isActive =
    selected.group === group &&
    (selected.sourceId ?? null) === (sourceId ?? null) &&
    (node.path ?? null) === (selected.path ?? null)
  const isRoot = node.path === null
  const hasChildren = node.children.length > 0
  const key = nodeKey(group, sourceId, node.path)
  const isCollapsed = hasChildren && collapse.collapsed.has(key)

  const toggle = (e: MouseEvent) => {
    e.stopPropagation()
    collapse.toggle(key)
  }

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
        {hasChildren ? (
          <button
            type="button"
            aria-label={isCollapsed ? 'Expand folder' : 'Collapse folder'}
            onClick={toggle}
            style={{
              width: 14,
              flex: '0 0 auto',
              display: 'inline-flex',
              justifyContent: 'center',
              alignItems: 'center',
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--text-dim)',
              fontSize: 9,
              userSelect: 'none',
              transform: isCollapsed ? 'rotate(-90deg)' : undefined,
              transition: 'transform 120ms ease'
            }}
          >
            ▼
          </button>
        ) : (
          <span style={{ width: 14, flex: '0 0 auto' }} />
        )}
        <Text
          fz="sm"
          truncate
          title={node.label}
          style={{ flex: 1, minWidth: 0, fontWeight: isActive || isRoot ? 600 : 400 }}
        >
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
      {!isCollapsed &&
        node.children.map((child) => (
          <FolderNodeRow
            key={child.path ?? '/'}
            node={child}
            depth={depth + 1}
            group={group}
            sourceId={sourceId}
            selected={selected}
            onSelect={onSelect}
            collapse={collapse}
            manageable={manageable}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
    </>
  )
}
