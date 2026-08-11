import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/api', () => ({ fetchConfig: vi.fn() }))

import { fetchConfig } from '../lib/api'
import { SignIn } from './sign-in'

const mockConfig = vi.mocked(fetchConfig)

function wrap(node: ReactNode) {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={['/sign-in']}>{node}</MemoryRouter>
    </MantineProvider>
  )
}

const BASE_CONFIG = {
  idps: [] as Array<'google' | 'github'>,
  publicBaseUrl: 'https://ctx.test',
  mcpBaseUrl: 'https://ctx.test',
  accessPolicy: 'open_domain' as const
}

describe('SignIn — Access-only deploys (no IdP allowlists)', () => {
  it('offers the organization sign-in instead of the "no IdPs" dead end', async () => {
    mockConfig.mockResolvedValue({ ...BASE_CONFIG, accessSso: true })
    wrap(<SignIn />)
    expect(
      await screen.findByText('Continue with your organization sign-in')
    ).toBeInTheDocument()
    expect(screen.queryByText(/No identity providers are configured/)).not.toBeInTheDocument()
  })

  it('still shows the "no IdPs" message when Access is not configured either', async () => {
    mockConfig.mockResolvedValue({ ...BASE_CONFIG, accessSso: false })
    wrap(<SignIn />)
    expect(
      await screen.findByText(/No identity providers are configured/)
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Continue with your organization sign-in')
    ).not.toBeInTheDocument()
  })

  it('tolerates a config payload without the accessSso field (deploy skew)', async () => {
    mockConfig.mockResolvedValue({ ...BASE_CONFIG })
    wrap(<SignIn />)
    expect(
      await screen.findByText(/No identity providers are configured/)
    ).toBeInTheDocument()
  })

  it('shows IdP buttons alongside the organization entry when both exist', async () => {
    mockConfig.mockResolvedValue({ ...BASE_CONFIG, idps: ['github'], accessSso: true })
    wrap(<SignIn />)
    expect(
      await screen.findByText('Continue with your organization sign-in')
    ).toBeInTheDocument()
    expect(screen.getByText('Sign in with GitHub')).toBeInTheDocument()
  })
})
