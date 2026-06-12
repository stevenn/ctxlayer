import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import type { DocSummary, MeResponse } from '@ctxlayer/shared'
import { DialogProvider } from '../../lib/dialogs'

// Render smoke-test for the post-split DocsList screen. We mock the api
// module at the exact specifier the component imports ('../../lib/api')
// so no network happens, then full-mount the screen and assert it reaches
// its post-fetch "ready" state without throwing. This catches prop-wiring
// regressions from the 1000+ LoC → folder split that typecheck can't.

// Fixtures live in vi.hoisted so they're initialised before the hoisted
// vi.mock factory below references them.
const { me, docs } = vi.hoisted(() => {
  const me: MeResponse = {
    id: 'u_1',
    email: 'op@example.com',
    name: 'Op',
    role: 'admin',
    idp: 'github'
  }
  const docs: DocSummary[] = [
    {
      id: 'd_1',
      title: 'Onboarding guide',
      slug: 'onboarding-guide',
      kind: 'doc',
      folder: null,
      gitSourceId: null,
      gitSourceSlug: null,
      gitSourceName: null,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_500,
      createdBy: { id: 'u_1', email: 'op@example.com', name: 'Op' },
      updatedBy: { id: 'u_1', email: 'op@example.com', name: 'Op' },
      lockedAt: null,
      lockedBy: null
    }
  ]
  return { me, docs }
})

vi.mock('../../lib/api', () => ({
  fetchMe: vi.fn().mockResolvedValue(me),
  fetchDocs: vi.fn().mockResolvedValue(docs),
  adminReindexAllDocs: vi.fn().mockResolvedValue({ queued: 0, total: 0 }),
  renameFolder: vi.fn().mockResolvedValue({ moved: 0, ids: [] }),
  deleteFolder: vi.fn().mockResolvedValue(undefined),
  patchDoc: vi.fn().mockResolvedValue(undefined)
}))

import { DocsList } from './index'

function renderScreen() {
  const router = createMemoryRouter([{ path: '/', element: <DocsList /> }])
  return render(
    <MantineProvider>
      <DialogProvider>
        <RouterProvider router={router} />
      </DialogProvider>
    </MantineProvider>
  )
}

describe('DocsList (render smoke)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('mounts and renders the library heading after the docs fetch resolves', async () => {
    renderScreen()
    expect(await screen.findByText('Context Library')).toBeInTheDocument()
    // The mocked doc lands in the table once fetchDocs resolves.
    expect(await screen.findByText('Onboarding guide')).toBeInTheDocument()
  })

  it('renders the empty-state when no docs come back', async () => {
    const api = await import('../../lib/api')
    vi.mocked(api.fetchDocs).mockResolvedValueOnce([])
    renderScreen()
    expect(await screen.findByText(/No docs yet/)).toBeInTheDocument()
  })
})
