import { describe, it, expect } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import type { UsageAsyncJobRow, UsageAsyncSummary, UsageErrorRow } from '@ctxlayer/shared'
import { ErrorsTable } from './errors-table'
import { AsyncJobsTable } from './async-jobs-table'

/**
 * The admin usage drill-down tables attribute each row to its caller via the
 * `showUser` prop; the personal views omit it. These assert the User column +
 * email appear only when opted in, and that a hard-deleted user (null email)
 * falls back to the raw id rather than blanking the row.
 */

function wrap(node: ReactNode) {
  return render(<MantineProvider>{node}</MantineProvider>)
}

const errorRow: UsageErrorRow = {
  ts: 1_780_000_000,
  tool: 'notion__search',
  upstreamId: 'ups-notion',
  upstreamSlug: 'up-notion',
  code: 'upstream_5xx',
  message: '500 internal server error',
  userId: 'u-alice',
  userEmail: 'alice@example.test'
}

const summary: UsageAsyncSummary = {
  total: 1,
  done: 1,
  running: 0,
  error: 0,
  timedOut: 0,
  avgDurationMs: 120000,
  maxDurationMs: 120000
}

const jobRow: UsageAsyncJobRow = {
  id: 'job-1',
  tool: 'gather_task_context',
  upstreamId: 'ups-driver',
  upstreamSlug: 'up-driver',
  status: 'done',
  createdAt: 1_780_000_000,
  completedAt: 1_780_000_120,
  durationMs: 120000,
  errorCode: null,
  userId: 'u-bob',
  userEmail: 'bob@example.test'
}

describe('usage tables — showUser column', () => {
  it('ErrorsTable shows the caller email only when showUser is set', () => {
    const { unmount } = wrap(<ErrorsTable rows={[errorRow]} range="30d" showUser />)
    expect(screen.getByText('User')).toBeInTheDocument()
    expect(screen.getByText('alice@example.test')).toBeInTheDocument()
    unmount()

    wrap(<ErrorsTable rows={[errorRow]} range="30d" />)
    expect(screen.queryByText('User')).not.toBeInTheDocument()
    expect(screen.queryByText('alice@example.test')).not.toBeInTheDocument()
  })

  it('AsyncJobsTable shows the caller email only when showUser is set', () => {
    const { unmount } = wrap(<AsyncJobsTable summary={summary} jobs={[jobRow]} showUser />)
    expect(screen.getByText('User')).toBeInTheDocument()
    expect(screen.getByText('bob@example.test')).toBeInTheDocument()
    unmount()

    wrap(<AsyncJobsTable summary={summary} jobs={[jobRow]} />)
    expect(screen.queryByText('User')).not.toBeInTheDocument()
    expect(screen.queryByText('bob@example.test')).not.toBeInTheDocument()
  })

  it('falls back to the raw user id when the email is null (deleted user)', () => {
    wrap(<AsyncJobsTable summary={summary} jobs={[{ ...jobRow, userEmail: null }]} showUser />)
    expect(screen.getByText('u-bob')).toBeInTheDocument()
  })
})
