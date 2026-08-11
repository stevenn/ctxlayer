import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TextInput } from '@mantine/core'
import { FormModalShell } from '../../components/form-modal-shell'
import { createDoc } from '../../lib/api'
import { useBusyAction } from '../../lib/use-busy'
import { useSlugSuggest } from '../../lib/use-slug-suggest'
import { explain } from './helpers'

// ----- Blank doc modal ---------------------------------------------------

// Conditionally mounted by the caller (`{createOpen && <BlankDocModal/>}`),
// so state initialises fresh on every open — the folder default is just
// the useState initial value, no `opened` prop / reset effect needed.
export function BlankDocModal({
  onClose,
  defaultFolder
}: {
  onClose: () => void
  defaultFolder: string | null
}) {
  const nav = useNavigate()
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState(defaultFolder ?? '')
  const slugField = useSlugSuggest('doc', title)
  const { busy, error, run: withBusy } = useBusyAction({ explain })

  async function submit() {
    const t = title.trim()
    if (!t) return
    const f = folder.trim() || null
    await withBusy(async () => {
      const { id } = await createDoc({
        title: t,
        folder: f,
        slug: slugField.slug.trim() || undefined
      })
      onClose()
      // A brand-new doc should land in the editor, not the read-only preview.
      nav(`/app/docs/${id}/edit`)
    }, 'Create')
  }

  return (
    <FormModalShell
      title="New doc"
      error={error}
      busy={busy}
      submitLabel="Create"
      submitDisabled={!title.trim()}
      onSubmit={submit}
      onClose={onClose}
    >
      <TextInput
        label="Title"
        placeholder="e.g. API Guidelines"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        data-autofocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <TextInput
        label="Slug"
        value={slugField.slug}
        onChange={(e) => slugField.setSlug(e.currentTarget.value)}
        description="Auto-filled from the title; edit to customise. Must start with doc-."
      />
      <TextInput
        label="Folder"
        placeholder="/specs/api  (leave blank for root)"
        value={folder}
        onChange={(e) => setFolder(e.currentTarget.value)}
        description="Optional. Slug-shaped segments separated by /, max depth 5."
      />
    </FormModalShell>
  )
}
