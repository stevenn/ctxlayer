import { useMemo, useState } from 'react'
import { Alert, Button, Group, Modal, Select, Stack } from '@mantine/core'
import { attachSkill, fetchSkills } from '../../../lib/api'
import { useLoad } from '../../../lib/use-load'
import { explain } from './helpers'

export function UpstreamSkillAttachModal({
  upstreamId,
  upstreamSlug,
  toolName,
  onClose,
  onAttached
}: {
  upstreamId: string
  upstreamSlug: string
  toolName: string
  onClose: () => void
  onAttached: () => void
}) {
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // One error channel shared by the skills load and the attach action.
  const [error, setError] = useState<string | null>(null)

  const { data: skills } = useLoad((signal) => fetchSkills({ status: 'all' }, signal), [], {
    explain,
    onError: setError
  })

  const options = useMemo(
    () =>
      (skills ?? []).map((s) => ({
        value: s.id,
        label: `${s.title}${s.status !== 'published' ? ` (${s.status})` : ''}`
      })),
    [skills]
  )

  async function submit() {
    if (!selectedSkillId) return
    setBusy(true)
    setError(null)
    try {
      await attachSkill({
        skillId: selectedSkillId,
        upstreamId,
        toolName: toolName || undefined
      })
      onAttached()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  const target = toolName ? `${upstreamSlug}.${toolName}` : `${upstreamSlug} (whole upstream)`
  return (
    <Modal opened onClose={onClose} title={`Attach skill to ${target}`} size="md">
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <Select
          label="Skill"
          placeholder={skills ? 'Pick a skill…' : 'Loading…'}
          data={options}
          value={selectedSkillId}
          onChange={setSelectedSkillId}
          searchable
          disabled={!skills || busy}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!selectedSkillId}>
            Attach
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
