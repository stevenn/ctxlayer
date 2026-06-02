import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'

// Mock the shared api module (resolves to the same file for both pages,
// regardless of the relative specifier each uses).
vi.mock('../lib/api', () => ({
  fetchUsage: vi
    .fn()
    .mockResolvedValue({ range: '30d', dailyTotals: [], topTools: [], topUpstreams: [] }),
  fetchAdminUsage: vi
    .fn()
    .mockResolvedValue({ range: '30d', dailyTotals: [], topTools: [], topUpstreams: [], topUsers: [] }),
  searchUsers: vi.fn().mockResolvedValue([])
}))

import { Usage } from './usage'
import { AdminUsage } from './admin/usage'

function wrap(node: ReactNode) {
  return render(<MantineProvider>{node}</MantineProvider>)
}

describe('usage pages', () => {
  it('Usage renders the personal dashboard', async () => {
    wrap(<Usage />)
    expect(await screen.findByText('Your usage')).toBeInTheDocument()
  })

  it('AdminUsage renders with the per-user email picker', async () => {
    wrap(<AdminUsage />)
    expect(await screen.findByText('Admin · Usage')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Filter by user (email)')).toBeInTheDocument()
  })
})
