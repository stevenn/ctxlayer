import { Text } from '@mantine/core'

/**
 * Compact user attribution cell for the admin usage drill-down tables
 * (errors + async jobs). Shows the email when known, else the raw user id
 * (a hard-deleted user has no email row to join). The full id is always in
 * the title attribute for hover, matching the "Top users" cell's id-under-email
 * pairing without the two-line footprint the dense tables can't spare.
 */
export function UserCell({ userId, email }: { userId: string | null; email: string | null }) {
  if (email) {
    return (
      <Text fz="xs" title={userId ?? undefined} style={{ wordBreak: 'break-word' }}>
        {email}
      </Text>
    )
  }
  if (userId) {
    return (
      <Text fz="xs" c="dimmed" title={userId}>
        <code style={{ fontSize: 11 }}>{userId}</code>
      </Text>
    )
  }
  return (
    <Text fz="xs" c="dimmed">
      —
    </Text>
  )
}
