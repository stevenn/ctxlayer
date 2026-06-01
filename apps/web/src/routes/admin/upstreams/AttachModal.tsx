import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Group, Modal, Select, Stack } from '@mantine/core'
import type { SkillSummary } from '@ctxlayer/shared'
import { attachSkill, fetchSkills } from '../../../lib/api'
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
  const [skills, setSkills] = useState<SkillSummary[] | null>(null)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchSkills({ status: 'all' })
      .then((rows) => !cancelled && setSkills(rows))
      .catch((err) => !cancelled && setError(explain(err)))
    return () => {
      cancelled = true
    }
  }, [])

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
