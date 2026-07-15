import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'

// Mock the shared api module (resolves to the same file for both pages,
// regardless of the relative specifier each uses).
vi.mock('../lib/api', () => ({
  fetchUsage: vi.fn().mockResolvedValue({
    range: '30d',
    dailyTotals: [],
    topTools: [],
    topUpstreams: [],
    recentErrors: [],
    asyncSummary: {
      total: 0,
      done: 0,
      running: 0,
      error: 0,
      timedOut: 0,
      avgDurationMs: null,
      maxDurationMs: null
    },
    asyncJobs: []
  }),
  fetchAdminUsage: vi.fn().mockResolvedValue({
    range: '30d',
    dailyTotals: [],
    topTools: [],
    topUpstreams: [],
    topUsers: [],
    recentErrors: [],
    asyncSummary: {
      total: 0,
      done: 0,
      running: 0,
      error: 0,
      timedOut: 0,
      avgDurationMs: null,
      maxDurationMs: null
    },
    asyncJobs: []
  }),
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
