import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import type { AdminUpstreamRow } from '@ctxlayer/shared'
import { DialogProvider } from '../../../lib/dialogs'

// Render smoke-test for the post-split AdminUpstreams screen. Mocks the
// api module at the component's own specifier ('../../../lib/api') and
// full-mounts the screen, asserting it reaches its post-fetch render with
// the title + table (and the empty-state variant) without throwing.

// Fixtures live in vi.hoisted so they're initialised before the hoisted
// vi.mock factory below references them.
const { upstreams } = vi.hoisted(() => {
  const upstreams: AdminUpstreamRow[] = [
    {
      id: 'up_1',
      slug: 'notion',
      displayName: 'Notion',
      transport: 'streamable_http',
      url: 'https://mcp.notion.example/mcp',
      authStrategy: 'user_oauth',
      authConfig: {},
      enabled: true,
      visibility: [],
      toolsCount: 7,
      toolsCachedAt: 1_700_000_000,
      currentUserConnected: true,
      sharedCredentialConfigured: false,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_500
    }
  ]
  return { upstreams }
})

vi.mock('../../../lib/api', () => ({
  fetchAdminUpstreams: vi.fn().mockResolvedValue(upstreams),
  fetchAdminUpstreamTools: vi.fn().mockResolvedValue({
    tools: [],
    attachedSkills: [],
    attachedDocs: []
  })
}))

import { AdminUpstreams } from './index'

function renderScreen() {
  const router = createMemoryRouter([{ path: '/', element: <AdminUpstreams /> }])
  return render(
    <MantineProvider>
      <DialogProvider>
        <RouterProvider router={router} />
      </DialogProvider>
    </MantineProvider>
  )
}

describe('AdminUpstreams (render smoke)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('mounts and renders the title + a row after the list fetch resolves', async () => {
    renderScreen()
    expect(await screen.findByText('Admin · Upstreams')).toBeInTheDocument()
    // The mocked upstream row lands in the table once the fetch resolves.
    expect(await screen.findByText('Notion')).toBeInTheDocument()
    expect(screen.getByText('notion')).toBeInTheDocument()
  })

  it('renders the empty-state when no upstreams come back', async () => {
    const api = await import('../../../lib/api')
    vi.mocked(api.fetchAdminUpstreams).mockResolvedValueOnce([])
    renderScreen()
    expect(await screen.findByText(/No upstreams yet/)).toBeInTheDocument()
  })
})
