import { useState } from 'react'
import { TextInput, Textarea } from '@mantine/core'
import type { CreateSkillRequest } from '@ctxlayer/shared'
import { FormModalShell } from '../../components/form-modal-shell'
import { createSkill } from '../../lib/api'
import { useBusyAction } from '../../lib/use-busy'
import { useSlugSuggest } from '../../lib/use-slug-suggest'
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
  // One error state shared by the pre-submit validation and the create call.
  const [error, setError] = useState<string | null>(null)
  const { busy, run: withBusy } = useBusyAction({ explain, setError })
  const slugField = useSlugSuggest('skill', title)

  async function submit() {
    if (!title.trim() || !description.trim()) {
      setError('Title and description are required.')
      return
    }
    await withBusy(async () => {
      const input: CreateSkillRequest = {
        title: title.trim(),
        description: description.trim(),
        slug: slugField.slug.trim() || undefined
      }
      const { id } = await createSkill(input)
      onCreated(id)
    }, 'Create draft')
  }

  return (
    <FormModalShell
      title="New skill"
      size="md"
      centered={false}
      error={error}
      errorFirst
      busy={busy}
      submitLabel="Create draft"
      onSubmit={submit}
      onClose={onClose}
    >
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
    </FormModalShell>
  )
}
