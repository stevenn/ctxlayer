import { useState } from 'react'
import type { DocDetail } from '@ctxlayer/shared'
import { patchDoc } from '../../lib/api'
import { useDialogs } from '../../lib/dialogs'
import { explain } from './helpers'

/**
 * Click-to-move folder cell. Read-only viewers see just the path. Editors
 * see a clickable cell that pops a prompt for the new path; empty string
 * moves the doc back to Root. Backend validates the path shape (same
 * FolderPath schema used at create time) and returns a 4xx on bad input,
 * which we surface as an alert.
 */
export function FolderField({
  doc,
  onChanged
}: {
  doc: DocDetail
  onChanged: () => Promise<void>
}) {
  const dialogs = useDialogs()
  const [busy, setBusy] = useState(false)
  const current = doc.folder

  async function move() {
    if (busy || !doc.canEdit) return
    const next = await dialogs.prompt({
      title: 'Move doc',
      message: 'Enter a folder path (e.g. /specs/api) or leave blank for Root.',
      defaultValue: current ?? '',
      placeholder: '/specs/api',
      confirmLabel: 'Move'
    })
    if (next === null) return
    const target = next.trim() === '' ? null : next.trim()
    if (target === current) return
    setBusy(true)
    try {
      await patchDoc(doc.id, { folder: target })
      await onChanged()
    } catch (err) {
      await dialogs.alert({ title: 'Move failed', message: explain(err) })
    } finally {
      setBusy(false)
    }
  }

  const label = current ? <code>{current}</code> : <span>Root</span>

  // Read-only when the doc can't be edited, or when it's git-synced —
  // git docs are foldered by their repo path (sync-owned), so the folder
  // isn't user-editable here.
  if (!doc.canEdit || doc.gitSourceId) return <div>{label}</div>

  return (
    <button
      type="button"
      onClick={move}
      style={{
        cursor: busy ? 'progress' : 'pointer',
        opacity: busy ? 0.6 : 1,
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
        textUnderlineOffset: 3,
        background: 'none',
        border: 'none',
        padding: 0,
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left'
      }}
      title="Click to move"
    >
      {label}
    </button>
  )
}
