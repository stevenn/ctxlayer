import { useState } from 'react'
import { Alert, Button, Group, Modal, Stack, TextInput, Textarea } from '@mantine/core'
import type { CreateSkillRequest } from '@ctxlayer/shared'
import { createSkill } from '../../../lib/api'
import { useSlugSuggest } from '../../../lib/use-slug-suggest'
import { explain } from './helpers'

export function CreateSkillModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const slugField = useSlugSuggest('skill', title)

  async function submit() {
    if (!title.trim() || !description.trim()) {
      setError('Title and description are required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const input: CreateSkillRequest = {
        title: title.trim(),
        description: description.trim(),
        slug: slugField.slug.trim() || undefined
      }
      const { id } = await createSkill(input)
      onCreated(id)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} title="New skill" size="md">
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <TextInput
          label="Title"
          placeholder="e.g. Linear customer-bug triage"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          required
          autoFocus
        />
        <TextInput
          label="Slug"
          description="Auto-filled from the title; edit to customise. Must start with sk-. Immutable after creation."
          value={slugField.slug}
          onChange={(e) => slugField.setSlug(e.currentTarget.value)}
        />
        <Textarea
          label="Description"
          description="One-line trigger: when should the agent use this skill?"
          placeholder="When a customer reports a bug, file it in Linear ENG with the triage label."
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          minRows={2}
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Create draft
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
