import { Group, Text } from '@mantine/core'
import type { TableSort } from '../lib/use-table-sort'

/**
 * Micro-components shared across the admin drawers/pages (and a few
 * non-admin surfaces). One canonical copy — don't re-define these
 * privately in a route file.
 */

/** Uppercase micro-label section header. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          marginBottom: 6
        }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

/** Small bold sub-heading inside a Section. */
export function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Text fz="xs" fw={500} mb={4}>
        {title}
      </Text>
      {children}
    </div>
  )
}

/** Dimmed-label / value row. `w` sets the label column width. */
export function KV({
  k,
  v,
  w = 80,
  mb
}: {
  k: string
  v: React.ReactNode
  w?: number
  mb?: number
}) {
  return (
    <Group gap="xs" wrap="nowrap" align="baseline" mb={mb}>
      <Text fz="xs" c="dimmed" w={w}>
        {k}
      </Text>
      <Text fz="sm" style={{ minWidth: 0 }}>
        {v}
      </Text>
    </Group>
  )
}

/**
 * Sortable `.data-table` header cell. The whole cell is the hit target
 * (the button fills it), the arrow shows for the active column and
 * faintly on hover elsewhere. Drive it with `useTableSort`:
 *
 *   const sort = useTableSort(filtered, { email: (u) => u.email, … }, …)
 *   <SortTh sort={sort} column="email" label="Email" />
 */
export function SortTh<K extends string>({
  sort,
  column,
  label
}: {
  sort: TableSort<K>
  column: K
  label: string
}) {
  const active = sort.key === column
  return (
    <th
      className="th-sortable"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" onClick={() => sort.toggle(column)}>
        {label}
        <span className={active ? 'th-arrow is-active' : 'th-arrow'} aria-hidden="true">
          {active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  )
}
