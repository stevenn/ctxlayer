import { Badge } from '@mantine/core'
import type { SkillStatus, SkillVisibility } from '@ctxlayer/shared'

/** Lifecycle badge (draft / published / archived). Shared by the user
 *  and admin skill lists so the colouring never drifts. */
export function StatusBadge({ status }: { status: SkillStatus }) {
  const colour = status === 'published' ? 'green' : status === 'draft' ? 'yellow' : 'gray'
  return (
    <Badge color={colour} variant={status === 'published' ? 'filled' : 'light'}>
      {status}
    </Badge>
  )
}

/** Audience badge (Private / Shared). Orthogonal to status — a skill is
 *  only live to the org when Shared AND published. */
export function VisibilityBadge({ visibility }: { visibility: SkillVisibility }) {
  return visibility === 'org' ? (
    <Badge color="blue" variant="light">
      Shared
    </Badge>
  ) : (
    <Badge color="gray" variant="light">
      Private
    </Badge>
  )
}
