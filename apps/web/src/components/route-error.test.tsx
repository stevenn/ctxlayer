import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { RouteError } from './route-error'

function Thrower(): never {
  throw new Error('boom: render exploded')
}

describe('RouteError', () => {
  it('renders a recoverable error UI when a route throws (no white screen)', () => {
    // A data router with an errorElement is exactly how app.tsx wires it.
    const router = createMemoryRouter([
      { path: '/', element: <Thrower />, errorElement: <RouteError /> }
    ])
    render(
      <MantineProvider>
        <RouterProvider router={router} />
      </MantineProvider>
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    // The thrown message is surfaced to aid bug reports.
    expect(screen.getByText(/boom: render exploded/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument()
  })
})
