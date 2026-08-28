import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'

vi.mock('../lib/api', () => ({
  fetchUsageErrors: vi.fn().mockResolvedValue({ range: '30d', errors: [] }),
  fetchAdminUsageErrors: vi.fn().mockResolvedValue({
    range: '30d',
    errors: [
      {
        ts: 1_700_000_000,
        tool: 'up-x__boom',
        upstreamId: 'ups-1',
        upstreamSlug: 'up-x',
        code: 'upstream_error',
        message: 'it broke',
        userId: 'u-1',
        userEmail: 'u1@example.test'
      }
    ]
  })
}))

import { Errors } from './errors'
import { AdminErrors } from './admin/errors'

function wrap(node: ReactNode) {
  return render(<MantineProvider>{node}</MantineProvider>)
}

describe('errors pages', () => {
  it('Errors renders the personal page', async () => {
    wrap(<Errors />)
    expect(await screen.findByText('Your errors')).toBeInTheDocument()
    expect(screen.getByText('Failed tool calls')).toBeInTheDocument()
  })

  it('AdminErrors renders rows with user attribution', async () => {
    wrap(<AdminErrors />)
    expect(await screen.findByText('Admin · Errors')).toBeInTheDocument()
    expect(await screen.findByText('it broke')).toBeInTheDocument()
    expect(screen.getByText('u1@example.test')).toBeInTheDocument()
  })
})
