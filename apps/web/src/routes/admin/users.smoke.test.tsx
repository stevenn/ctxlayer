import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import type { AdminUserRow } from '@ctxlayer/shared'
import { DialogProvider } from '../../lib/dialogs'

// jsdom has no ResizeObserver; Mantine's SegmentedControl indicator wants one.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

// Column sorting on the admin users table. The rows below are returned in
// the API's own order (email ascending) so the default render doubles as
// the "unchanged first paint" assertion.
const { users } = vi.hoisted(() => {
  const now = Math.floor(Date.now() / 1000)
  const base = {
    name: null,
    avatarUrl: null,
    role: 'user' as const,
    idp: 'github' as const,
    status: 'active' as const,
    createdAt: now - 86_400 * 30,
    teams: [],
    roles: [],
    credentialCount: 0
  }
  const users: AdminUserRow[] = [
    { ...base, id: 'u-a', email: 'ann@example.com', lastSeenAt: now - 60 },
    { ...base, id: 'u-b', email: 'bob@example.com', lastSeenAt: null },
    { ...base, id: 'u-c', email: 'cal@example.com', lastSeenAt: now - 86_400 * 3 }
  ]
  return { users }
})

vi.mock('../../lib/api', () => ({
  fetchAdminUsers: vi.fn().mockResolvedValue(users),
  fetchRoles: vi.fn().mockResolvedValue([])
}))

import { AdminUsers } from './users'

function renderScreen() {
  return render(
    <MantineProvider>
      <DialogProvider>
        <AdminUsers />
      </DialogProvider>
    </MantineProvider>
  )
}

/**
 * Emails in render order. Queried through the DOM rather than
 * `getAllByRole('row')` because `clickableRow` gives each body row
 * `role="button"`, which shadows the implicit row role.
 */
function emailOrder(): string[] {
  return [...document.querySelectorAll('.data-table tbody tr')].map(
    (row) => row.querySelector('td')?.textContent ?? ''
  )
}

describe('AdminUsers sorting', () => {
  it('defaults to email ascending and sorts by last seen on click', async () => {
    renderScreen()
    expect(await screen.findByText('ann@example.com')).toBeInTheDocument()
    expect(emailOrder()).toEqual(['ann@example.com', 'bob@example.com', 'cal@example.com'])

    // First click on a timestamp column sorts most-recent-first; the
    // never-seen user sinks to the bottom.
    fireEvent.click(screen.getByRole('button', { name: /last seen/i }))
    expect(emailOrder()).toEqual(['ann@example.com', 'cal@example.com', 'bob@example.com'])

    // Second click flips to oldest-first — nulls stay last in both directions.
    fireEvent.click(screen.getByRole('button', { name: /last seen/i }))
    expect(emailOrder()).toEqual(['cal@example.com', 'ann@example.com', 'bob@example.com'])
  })

  it('marks the active column with aria-sort', async () => {
    renderScreen()
    await screen.findByText('ann@example.com')
    expect(screen.getByRole('columnheader', { name: /email/i })).toHaveAttribute(
      'aria-sort',
      'ascending'
    )

    fireEvent.click(screen.getByRole('button', { name: /email/i }))
    expect(screen.getByRole('columnheader', { name: /email/i })).toHaveAttribute(
      'aria-sort',
      'descending'
    )
    expect(emailOrder()).toEqual(['cal@example.com', 'bob@example.com', 'ann@example.com'])
    expect(screen.getByRole('columnheader', { name: /creds/i })).toHaveAttribute('aria-sort', 'none')
  })
})
