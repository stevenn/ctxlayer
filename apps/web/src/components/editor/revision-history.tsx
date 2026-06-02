import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Drawer, Group, Loader, Stack, Text } from '@mantine/core'
import type { DocContent } from '@ctxlayer/shared'
import { useDialogs } from '../../lib/dialogs'
import { explain } from '../../lib/explain'

/**
 * Revision summary shape shared by docs (RevisionSummary) and skills
 * (SkillRevisionSummary) — both are structurally identical. Declared
 * locally so this one component serves both editors without importing a
 * union from @ctxlayer/shared.
 */
export interface RevisionSummaryLike {
  id: string
  authorId?: string | null
  createdAt: number
  byteSize: number
  contentHash: string
}

export interface RevisionHistoryProps {
  opened: boolean
  onClose: () => void
  /** Doc/skill title — shown in the drawer header. */
  title: string
  /** List saved revisions (server returns newest-first; we re-sort defensively). */
  list: () => Promise<RevisionSummaryLike[]>
  /** Fetch a revision's content so the editor can re-seed from it. */
  fetchContent: (revisionId: string) => Promise<DocContent>
  /** Persist a restore (creates a fresh revision from the chosen one). */
  restore: (revisionId: string) => Promise<unknown>
  /**
   * Called after a successful restore with the restored content. The
   * editor uses this to push the content into its live document (for the
   * collab doc editor that means replaceBlocks → the Y.Doc, so peers + the
   * collab DO snapshot pick it up; a plain reload would NOT reseed a live
   * Y.Doc). Awaited before the drawer closes.
   */
  onRestored: (content: DocContent) => void | Promise<void>
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; revisions: RevisionSummaryLike[] }
  | { kind: 'error'; message: string }

export function RevisionHistory({
  opened,
  onClose,
  title,
  list,
  fetchContent,
  restore,
  onRestored
}: RevisionHistoryProps) {
  const dialogs = useDialogs()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState({ kind: 'loading' })
      try {
        const revisions = await list()
        if (signal?.aborted) return
        revisions.sort((a, b) => b.createdAt - a.createdAt)
        setState({ kind: 'ready', revisions })
      } catch (err) {
        if (signal?.aborted) return
        setState({ kind: 'error', message: explain(err) })
      }
    },
    [list]
  )

  useEffect(() => {
    if (!opened) return
    const ctrl = new AbortController()
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [opened, load])

  const onRestoreClick = useCallback(
    async (rev: RevisionSummaryLike) => {
      // Close the slideout first so the confirm dialog isn't layered behind
      // the drawer overlay.
      onClose()
      const ok = await dialogs.confirm({
        title: 'Restore this version?',
        message: `Restore "${title}" to the version from ${formatTimestamp(rev.createdAt)}? This saves it as a new revision — the current version stays in the history.`,
        confirmLabel: 'Restore'
      })
      if (!ok) return
      setRestoringId(rev.id)
      try {
        await restore(rev.id)
        // Pull the restored content (the source revision's body) so the
        // editor can push it into its live document. Done here rather than
        // relying on a reload so a live collab session reflects it.
        const content = await fetchContent(rev.id)
        await onRestored(content)
      } catch (err) {
        await dialogs.alert({ title: 'Restore failed', message: explain(err) })
      } finally {
        setRestoringId(null)
      }
    },
    [dialogs, title, restore, fetchContent, onRestored, onClose]
  )

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={<Text fw={600}>Revision history</Text>}
    >
      {state.kind === 'loading' && (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      )}

      {state.kind === 'error' && (
        <Stack gap="sm">
          <Text c="red" fz="sm">
            {state.message}
          </Text>
          <Button variant="default" size="xs" w={120} onClick={() => void load()}>
            Retry
          </Button>
        </Stack>
      )}

      {state.kind === 'ready' && state.revisions.length === 0 && (
        <Text c="dimmed" fz="sm">
          No saved revisions yet.
        </Text>
      )}

      {state.kind === 'ready' && state.revisions.length > 0 && (
        <Stack gap="xs">
          {state.revisions.map((rev, i) => (
            <RevisionRow
              key={rev.id}
              rev={rev}
              isCurrent={i === 0}
              restoring={restoringId === rev.id}
              disabled={restoringId !== null}
              onRestore={() => void onRestoreClick(rev)}
            />
          ))}
        </Stack>
      )}
    </Drawer>
  )
}

function RevisionRow({
  rev,
  isCurrent,
  restoring,
  disabled,
  onRestore
}: {
  rev: RevisionSummaryLike
  isCurrent: boolean
  restoring: boolean
  disabled: boolean
  onRestore: () => void
}) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      align="flex-start"
      style={{
        borderBottom: '1px solid var(--border)',
        paddingBottom: 8
      }}
    >
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Text fz="sm" fw={500}>
            {formatTimestamp(rev.createdAt)}
          </Text>
          {isCurrent && (
            <Badge size="xs" variant="light" color="blue">
              Current
            </Badge>
          )}
        </Group>
        <Text fz="xs" c="dimmed">
          {authorLabel(rev.authorId)} · {formatBytes(rev.byteSize)}
        </Text>
      </Stack>
      {!isCurrent && (
        <Button
          size="xs"
          variant="default"
          loading={restoring}
          disabled={disabled && !restoring}
          onClick={onRestore}
        >
          Restore
        </Button>
      )}
    </Group>
  )
}

/**
 * Standalone trigger so editors can drop a "History" button into their
 * header that matches the surrounding Mantine buttons. Owns the
 * open/close state + the drawer itself.
 */
export function RevisionHistoryButton(props: Omit<RevisionHistoryProps, 'opened' | 'onClose'>) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)}>
        History
      </Button>
      <RevisionHistory {...props} opened={open} onClose={() => setOpen(false)} />
    </>
  )
}

// ----- formatting helpers -------------------------------------------------

function authorLabel(authorId: string | null | undefined): string {
  if (!authorId) return '—'
  // Revisions carry only an id (no email is resolved server-side); show a
  // short, stable handle so concurrent authors are still distinguishable.
  return authorId.length > 10 ? `${authorId.slice(0, 8)}…` : authorId
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}
