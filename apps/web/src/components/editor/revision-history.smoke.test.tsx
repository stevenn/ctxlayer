import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { DialogProvider } from '../../lib/dialogs'
import { RevisionHistory, type RevisionSummaryLike } from './revision-history'

function wrap(node: ReactNode) {
  return render(
    <MantineProvider>
      <DialogProvider>{node}</DialogProvider>
    </MantineProvider>
  )
}

const revisions: RevisionSummaryLike[] = [
  {
    id: 'rev_new',
    authorId: 'u_abcdef123456',
    createdAt: 1_700_000_500,
    byteSize: 4096,
    contentHash: 'h1'
  },
  {
    id: 'rev_old',
    authorId: null,
    createdAt: 1_700_000_000,
    byteSize: 12,
    contentHash: 'h2'
  }
]

describe('RevisionHistory (render smoke)', () => {
  it('renders a row per revision with size + current flag', async () => {
    const list = vi.fn().mockResolvedValue(revisions)
    const restore = vi.fn().mockResolvedValue({ revisionId: 'rev_restored' })
    const fetchContent = vi.fn().mockResolvedValue({ blocks: [] })
    const onRestored = vi.fn()

    wrap(
      <RevisionHistory
        opened
        onClose={() => {}}
        title="My Doc"
        list={list}
        fetchContent={fetchContent}
        restore={restore}
        onRestored={onRestored}
      />
    )

    // Newest revision (4 KB) renders its size; author + size share one line,
    // so match on a substring.
    expect(await screen.findByText(/4\.0 KB/)).toBeInTheDocument()
    expect(screen.getByText(/12 B/)).toBeInTheDocument()
    expect(screen.getByText('Current')).toBeInTheDocument()
    // The current (newest) row has no Restore button; the older one does.
    expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(1)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state when there are no revisions', async () => {
    const list = vi.fn().mockResolvedValue([])
    wrap(
      <RevisionHistory
        opened
        onClose={() => {}}
        title="Empty Doc"
        list={list}
        fetchContent={vi.fn()}
        restore={vi.fn()}
        onRestored={vi.fn()}
      />
    )
    expect(await screen.findByText('No saved revisions yet.')).toBeInTheDocument()
  })
})
