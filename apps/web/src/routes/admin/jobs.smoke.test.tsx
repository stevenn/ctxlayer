import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'

// jsdom has no ResizeObserver; the timeline measures its container with one.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

vi.mock('../../lib/api', () => ({
  fetchAdminJobs: vi.fn().mockResolvedValue({
    range: '30d',
    runs: [
      {
        id: 'r-1',
        task: 'keep-warm',
        startedAt: Math.floor(Date.now() / 1000) - 3600,
        durationMs: 812,
        status: 'ok',
        summary: { due: 2, warmed: 2, failed: 0 },
        error: null
      },
      {
        id: 'r-2',
        task: 'git-sync',
        startedAt: Math.floor(Date.now() / 1000) - 7200,
        durationMs: 4210,
        status: 'error',
        summary: { source: 'gs-kb' },
        error: 'no_read_token'
      }
    ]
  })
}))

import { AdminJobs } from './jobs'

function wrap(node: ReactNode) {
  return render(<MantineProvider>{node}</MantineProvider>)
}

describe('AdminJobs', () => {
  it('renders the timeline lanes, legend, and runs table', async () => {
    wrap(<AdminJobs />)
    expect(await screen.findByText('Admin · Jobs')).toBeInTheDocument()
    // Timeline lane labels (SVG text) + legend
    expect(await screen.findAllByText('keep-warm')).not.toHaveLength(0)
    expect(screen.getByText('partial')).toBeInTheDocument() // legend entry
    // Table drill-down content
    expect(screen.getByText('no_read_token')).toBeInTheDocument()
  })
})
