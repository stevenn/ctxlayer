import { useState } from 'react'
import type { DocDetail } from '@ctxlayer/shared'
import { patchDoc } from '../../lib/api'
import { useDialogs } from '../../lib/dialogs'
import { explain } from './helpers'

/** The DocDetail keys this field can edit — all nullable OKF strings. */
type OkfField = 'docType' | 'description' | 'resource'

/**
 * Click-to-edit rail cell for an OKF frontmatter string (Type, Description,
 * Resource). Mirrors FolderField: read-only viewers see the value; editors
 * get a dotted-underline button that pops a prompt and PATCHes the doc.
 * Empty values render as a muted placeholder so the row stays clickable.
 *
 * Unlike folders, these ARE editable on git-synced docs — they ride back to
 * the repo frontmatter on the next write-back, same as body edits.
 */
export function PropertyField({
  doc,
  field,
  prompt,
  multiline = false,
  onChanged
}: {
  doc: DocDetail
  field: OkfField
  prompt: { title: string; message: string; placeholder: string }
  multiline?: boolean
  onChanged: () => Promise<void>
}) {
  const dialogs = useDialogs()
  const [busy, setBusy] = useState(false)
  const current = doc[field] ?? null

  async function edit() {
    if (busy || !doc.canEdit) return
    const next = await dialogs.prompt({
      title: prompt.title,
      message: prompt.message,
      defaultValue: current ?? '',
      placeholder: prompt.placeholder,
      confirmLabel: 'Save',
      multiline
    })
    if (next === null) return
    const value = next.trim() === '' ? null : next.trim()
    if (value === current) return
    setBusy(true)
    try {
      await patchDoc(doc.id, { [field]: value })
      await onChanged()
    } catch (err) {
      await dialogs.alert({ title: 'Save failed', message: explain(err) })
    } finally {
      setBusy(false)
    }
  }

  const label = current ? renderValue(field, current) : <span>—</span>

  if (!doc.canEdit) return <div>{label}</div>

  return (
    <button
      type="button"
      onClick={edit}
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
        textAlign: 'left',
        maxWidth: '100%',
        wordBreak: 'break-word'
      }}
      title={current ? 'Click to edit' : 'Click to set'}
    >
      {label}
    </button>
  )
}

function renderValue(field: OkfField, value: string): React.ReactNode {
  // A `resource` that looks like an http(s) URL renders as a (non-clickable
  // inside the edit button) code span so it's recognisable; everything else
  // is plain text.
  if (field === 'resource' && /^https?:\/\//i.test(value)) return <code>{value}</code>
  return <span>{value}</span>
}
