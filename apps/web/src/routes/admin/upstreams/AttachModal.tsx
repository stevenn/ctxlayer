import { useMemo, useState } from 'react'
import { Select } from '@mantine/core'
import { FormModalShell } from '../../../components/form-modal-shell'
import { attachSkill, fetchSkills } from '../../../lib/api'
import { useBusyAction } from '../../../lib/use-busy'
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
  // One error channel shared by the skills load and the attach action.
  const [error, setError] = useState<string | null>(null)
  const { busy, run: withBusy } = useBusyAction({ explain, setError })

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
    await withBusy(async () => {
      await attachSkill({
        skillId: selectedSkillId,
        upstreamId,
        toolName: toolName || undefined
      })
      onAttached()
    }, 'Attach')
  }

  const target = toolName ? `${upstreamSlug}.${toolName}` : `${upstreamSlug} (whole upstream)`
  return (
    <FormModalShell
      title={`Attach skill to ${target}`}
      size="md"
      centered={false}
      error={error}
      errorFirst
      busy={busy}
      submitLabel="Attach"
      submitDisabled={!selectedSkillId}
      onSubmit={submit}
      onClose={onClose}
    >
      <Select
        label="Skill"
        placeholder={skills ? 'Pick a skill…' : 'Loading…'}
        data={options}
        value={selectedSkillId}
        onChange={setSelectedSkillId}
        searchable
        disabled={!skills || busy}
      />
    </FormModalShell>
  )
}
