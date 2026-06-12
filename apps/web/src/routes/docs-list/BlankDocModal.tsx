import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Group, Modal, Stack, TextInput } from '@mantine/core'
import { createDoc } from '../../lib/api'
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const slugField = useSlugSuggest('doc', title)

  async function submit() {
    const t = title.trim()
    if (!t) return
    const f = folder.trim() || null
    setBusy(true)
    setError(null)
    try {
      const { id } = await createDoc({
        title: t,
        folder: f,
        slug: slugField.slug.trim() || undefined
      })
      onClose()
      nav(`/app/docs/${id}`)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} title="New doc" centered>
      <Stack gap="md">
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
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!title.trim()}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
