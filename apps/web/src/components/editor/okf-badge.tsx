import { Tooltip } from '@mantine/core'

/**
 * Small "OKF" pill marking a rail field that maps directly to a frontmatter
 * key in the Open Knowledge Format. The tooltip explains the mapping so the
 * connection to the OKF schema is discoverable on hover. Shared by the doc
 * editor's property rows and the tag pane's Tags section.
 */
const NOTES: Record<OkfField, string> = {
  type: 'OKF frontmatter "type" — a short label for the kind of concept (e.g. Playbook, API Endpoint, Reference). Required by the Open Knowledge Format.',
  description: 'OKF frontmatter "description" — a single-sentence summary of the concept.',
  resource: 'OKF frontmatter "resource" — a URI identifying the underlying asset this doc describes.',
  tags: 'OKF frontmatter "tags" — free-form categorisation. These map to OKF tags; team and product tags are ctxlayer-only and do not.'
}

export type OkfField = 'type' | 'description' | 'resource' | 'tags'

export function OkfBadge({ field }: { field: OkfField }) {
  return (
    <Tooltip
      label={NOTES[field]}
      multiline
      w={250}
      withArrow
      position="top-start"
      fz="xs"
      events={{ hover: true, focus: true, touch: true }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.04em',
          lineHeight: 1.2,
          padding: '1px 4px',
          borderRadius: 3,
          color: 'var(--brand)',
          border: '1px solid var(--brand)',
          textTransform: 'none',
          cursor: 'help'
        }}
      >
        OKF
      </span>
    </Tooltip>
  )
}
