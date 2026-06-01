import { useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import type { DocDetail } from '@ctxlayer/shared'
import { setDocLocked } from '../../lib/api'
import { useDialogs } from '../../lib/dialogs'
import { personLabel } from '../docs-list'
import { explain, formatAbsolute } from './helpers'

/**
 * Padlock in the header. Renders for everyone when the doc is locked
 * (so viewers see *why* the editor is read-only via the tooltip) and for
 * lock-capable users when the doc is unlocked (so they can lock it).
 * Clicking is a no-op for users without canLock — they just get the
 * tooltip explaining the locked state. Locking asks for confirmation so
 * an accidental click doesn't freeze everyone mid-edit.
 */
export function LockIndicator({
  doc,
  onChanged
}: {
  doc: DocDetail
  onChanged: () => Promise<void>
}) {
  const dialogs = useDialogs()
  const [busy, setBusy] = useState(false)
  const locked = !!doc.lockedAt

  if (!locked && !doc.canLock) return null

  async function toggle() {
    if (busy || !doc.canLock) return
    if (!locked) {
      const ok = await dialogs.confirm({
        title: 'Lock doc',
        message: `Lock "${doc.title}"? Content, title, and tags become read-only for everyone (including you) until you unlock.`,
        confirmLabel: 'Lock'
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      await setDocLocked(doc.id, { locked: !locked })
      await onChanged()
    } catch (err) {
      await dialogs.alert({
        title: `${locked ? 'Unlock' : 'Lock'} failed`,
        message: explain(err)
      })
    } finally {
      setBusy(false)
    }
  }

  const tooltipLabel = locked
    ? `Locked by ${personLabel(doc.lockedBy)} on ${formatAbsolute(doc.lockedAt!)} — ${
        doc.canLock ? 'click to unlock' : 'an admin or the creator can unlock'
      }`
    : 'Lock this doc — content, title, and tags become read-only until unlocked'

  return (
    <Tooltip label={tooltipLabel} withArrow multiline maw={280}>
      <ActionIcon
        variant={locked ? 'light' : 'subtle'}
        color={locked ? 'yellow' : 'gray'}
        size="lg"
        onClick={toggle}
        loading={busy}
        style={{ cursor: doc.canLock ? 'pointer' : 'default' }}
        aria-label={locked ? 'Locked' : 'Unlocked'}
      >
        {locked ? <PadlockClosedIcon /> : <PadlockOpenIcon />}
      </ActionIcon>
    </Tooltip>
  )
}

function PadlockClosedIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

function PadlockOpenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </svg>
  )
}
