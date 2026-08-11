import type { ReactNode } from 'react'
import { Alert, Group, Text, Title } from '@mantine/core'

/**
 * The admin/list route skeleton that grew as copy-paste twins (roles ↔
 * teams ↔ products ↔ …, 2026-08 review theme D): header row with the
 * page action, the red error Alert, the Loading placeholder, and the
 * empty state. The TABLE stays in the route file — column sets, cell
 * renderers and badges differ everywhere, and a column-config prop is
 * exactly the config monster the review warns against.
 *
 * `empty` is shown (instead of children) when the caller passes it
 * non-null — the caller owns the "is it empty" decision since it owns
 * the data shape.
 */
export function ListPageShell({
  title,
  action,
  description,
  error,
  loading,
  empty,
  children
}: {
  title: string
  /** The `+ New …` button (or null for read-only pages). */
  action?: ReactNode
  /** Optional intro blurb under the header (always visible). */
  description?: ReactNode
  error: string | null
  loading: boolean
  empty?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          {title}
        </Title>
        {action}
      </Group>
      {description}
      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {loading && <Text c="dimmed">Loading…</Text>}
      {!loading && (empty ?? children)}
    </>
  )
}
