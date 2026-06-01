import { useEffect, useState } from 'react'
import { useBlocker } from 'react-router-dom'
import { Badge, Button, Group, Modal, Stack, Text } from '@mantine/core'

/**
 * Shared save UI + navigation guard for the doc and skill editors.
 *
 * Both editors keep a background autosave (crash-insurance) but the
 * user-facing notion of "saved" tracks EXPLICIT saves: `dirty` means
 * "edited since the last Save click (or since the doc was opened)".
 *
 *   - <SaveControls>  the save-state badge + Save + Discard buttons
 *   - <LeaveGuard>    blocks in-app navigation (useBlocker) and tab
 *                     close (beforeunload) while dirty, forcing an
 *                     explicit Save / Discard / Cancel choice
 *
 * onSave / onDiscard return a boolean: true on success (the guard then
 * lets navigation proceed), false on failure (the guard stays open and
 * shows the error).
 */

// Shared autosave idle debounce for both editors (docs + skills) so the
// two can't drift. Docs additionally keeps a max-coalesce window of its
// own, tied to the collab DO's snapshot cadence.
export const SAVE_IDLE_MS = 3_000

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'autosaved' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }

export function SaveBadge({ state }: { state: SaveState }) {
  if (state.kind === 'idle') return null
  if (state.kind === 'dirty')
    return (
      <Badge color="yellow" variant="light">
        unsaved
      </Badge>
    )
  if (state.kind === 'saving')
    return (
      <Badge color="blue" variant="light">
        saving…
      </Badge>
    )
  // Distinct from "saved": work is persisted as crash-insurance, but the
  // user hasn't explicitly saved, so the nav guard is still armed.
  if (state.kind === 'autosaved')
    return (
      <Badge color="gray" variant="light" title="Autosaved — click Save to confirm">
        autosaved
      </Badge>
    )
  if (state.kind === 'saved')
    return (
      <Badge color="green" variant="light">
        saved
      </Badge>
    )
  return (
    <Badge color="red" variant="light" title={state.message}>
      save failed
    </Badge>
  )
}

export function SaveControls({
  state,
  dirty,
  onSave,
  onDiscard
}: {
  state: SaveState
  dirty: boolean
  onSave: () => Promise<boolean>
  onDiscard: () => Promise<boolean>
}) {
  const [busy, setBusy] = useState<null | 'save' | 'discard'>(null)
  const saving = state.kind === 'saving' || busy !== null

  return (
    <Group gap="xs" wrap="nowrap">
      <SaveBadge state={state} />
      <Button
        variant="subtle"
        color="red"
        size="xs"
        disabled={!dirty || saving}
        loading={busy === 'discard'}
        onClick={async () => {
          setBusy('discard')
          try {
            await onDiscard()
          } finally {
            setBusy(null)
          }
        }}
      >
        Discard
      </Button>
      <Button
        size="xs"
        disabled={!dirty || saving}
        loading={busy === 'save'}
        onClick={async () => {
          setBusy('save')
          try {
            await onSave()
          } finally {
            setBusy(null)
          }
        }}
      >
        Save
      </Button>
    </Group>
  )
}

export function LeaveGuard({
  dirty,
  onSave,
  onDiscard
}: {
  dirty: boolean
  onSave: () => Promise<boolean>
  onDiscard: () => Promise<boolean>
}) {
  const blocker = useBlocker(dirty)
  const [busy, setBusy] = useState<null | 'save' | 'discard'>(null)
  const [error, setError] = useState<string | null>(null)

  // Native browser prompt for tab close / refresh / external navigation —
  // useBlocker only catches in-app (React Router) navigation.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  if (blocker.state !== 'blocked') return null

  async function resolve(action: 'save' | 'discard') {
    setBusy(action)
    setError(null)
    try {
      const ok = action === 'save' ? await onSave() : await onDiscard()
      if (ok) {
        blocker.proceed?.()
      } else {
        setError('Could not save. Resolve the error and try again, or discard.')
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal opened onClose={() => blocker.reset?.()} title="Unsaved changes" centered size="md">
      <Stack gap="md">
        <Text fz="sm">
          You have unsaved changes. Save them, discard them, or stay on the page. Discarding reverts
          to your last save.
        </Text>
        {error && (
          <Text fz="sm" c="red">
            {error}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={() => blocker.reset?.()} disabled={busy !== null}>
            Cancel
          </Button>
          <Button
            variant="subtle"
            color="red"
            onClick={() => resolve('discard')}
            loading={busy === 'discard'}
            disabled={busy === 'save'}
          >
            Discard &amp; leave
          </Button>
          <Button
            onClick={() => resolve('save')}
            loading={busy === 'save'}
            disabled={busy === 'discard'}
          >
            Save &amp; leave
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
