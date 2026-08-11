import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FormModalShell } from './form-modal-shell'
import { ListPageShell } from './list-page-shell'

/**
 * Prop-wiring smoke for the two extraction shells (2026-08 review,
 * theme D) — same rationale as docs-editor/components.smoke.test.tsx:
 * prove the extraction kept the chrome contract, not pixel styling.
 */

const ui = (node: React.ReactNode) => render(<MantineProvider>{node}</MantineProvider>)

describe('ListPageShell', () => {
  it('renders header, error, and children when loaded', () => {
    ui(
      <ListPageShell title="Admin · Things" action={<button type="button">+ New</button>} error="Boom" loading={false}>
        <table>
          <tbody>
            <tr>
              <td>row-1</td>
            </tr>
          </tbody>
        </table>
      </ListPageShell>
    )
    expect(screen.getByText('Admin · Things')).toBeInTheDocument()
    expect(screen.getByText('+ New')).toBeInTheDocument()
    expect(screen.getByText('Boom')).toBeInTheDocument()
    expect(screen.getByText('row-1')).toBeInTheDocument()
  })

  it('shows Loading… instead of children while loading, and empty over children', () => {
    const { rerender } = ui(
      <ListPageShell title="T" error={null} loading>
        <div>rows</div>
      </ListPageShell>
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('rows')).not.toBeInTheDocument()

    rerender(
      <MantineProvider>
        <ListPageShell title="T" error={null} loading={false} empty={<div>Nothing yet</div>}>
          <div>rows</div>
        </ListPageShell>
      </MantineProvider>
    )
    expect(screen.getByText('Nothing yet')).toBeInTheDocument()
    expect(screen.queryByText('rows')).not.toBeInTheDocument()
  })
})

describe('FormModalShell', () => {
  it('wires title, fields, footer buttons and the error alert', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    ui(
      <FormModalShell
        title="New thing"
        error="Create failed: nope"
        busy={false}
        submitLabel="Create"
        onSubmit={onSubmit}
        onClose={onClose}
      >
        <input aria-label="Name" />
      </FormModalShell>
    )
    expect(screen.getByText('New thing')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.getByText('Create failed: nope')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSubmit).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('disables submit via submitDisabled and renders footerLeft in a spread footer', () => {
    ui(
      <FormModalShell
        title="Edit"
        error={null}
        busy={false}
        submitLabel="Save"
        submitDisabled
        onSubmit={() => {}}
        onClose={() => {}}
        footerLeft={<button type="button">Delete</button>}
      >
        <div />
      </FormModalShell>
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })
})
