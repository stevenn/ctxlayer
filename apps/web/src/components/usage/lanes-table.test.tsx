import { describe, it, expect } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import type { UsageErrorRow, UsageLaneStats } from '@ctxlayer/shared'
import { LanesTable } from './lanes-table'
import { ErrorsTable } from './errors-table'

function wrap(node: ReactNode) {
  return render(<MantineProvider>{node}</MantineProvider>)
}

const lane = (over: Partial<UsageLaneStats>): UsageLaneStats => ({
  lane: 'session',
  calls: 0,
  errors: 0,
  timeouts: 0,
  users: 0,
  p50LatencyMs: null,
  p95LatencyMs: null,
  lastSeen: null,
  protocolVersions: [],
  clients: [],
  ...over
})

describe('LanesTable', () => {
  it('shows each lane with its share, latency, revisions and clients', () => {
    wrap(
      <LanesTable
        lanes={[
          lane({
            lane: 'session',
            calls: 300,
            errors: 6,
            users: 4,
            p50LatencyMs: 420,
            p95LatencyMs: 2500,
            lastSeen: 1_780_000_000,
            protocolVersions: ['2025-11-25'],
            clients: [{ clientName: 'claude-code', calls: 300, users: 4, lastSeen: 1_780_000_000 }]
          }),
          lane({
            lane: 'stateless',
            calls: 100,
            users: 2,
            p50LatencyMs: 380,
            protocolVersions: ['2026-07-28'],
            clients: [{ clientName: null, calls: 100, users: 2, lastSeen: 1_780_000_000 }]
          })
        ]}
      />
    )
    expect(screen.getByText('Session (2025-era)')).toBeInTheDocument()
    expect(screen.getByText('Stateless (2026-07-28)')).toBeInTheDocument()
    expect(screen.getByText('75.0%')).toBeInTheDocument() // 300 of 400 calls
    expect(screen.getByText('25.0%')).toBeInTheDocument()
    expect(screen.getByText('2.0%')).toBeInTheDocument() // 6 errors of 300
    expect(screen.getByText('420 ms')).toBeInTheDocument()
    expect(screen.getByText('2.5 s')).toBeInTheDocument()
    expect(screen.getByText('2025-11-25')).toBeInTheDocument()
    expect(screen.getByText('claude-code · 300')).toBeInTheDocument()
    expect(screen.getByText('unnamed client · 100')).toBeInTheDocument()
  })

  it('labels events from before lane tracking as unknown', () => {
    wrap(<LanesTable lanes={[lane({ lane: null, calls: 5 })]} />)
    expect(screen.getByText('Unknown (before lane tracking)')).toBeInTheDocument()
  })

  it('says so when there is nothing to show', () => {
    wrap(<LanesTable lanes={[]} />)
    expect(screen.getByText(/No tool calls/)).toBeInTheDocument()
  })
})

describe('ErrorsTable lane column', () => {
  const row: UsageErrorRow = {
    ts: 1_780_000_000,
    tool: 'notion__search',
    upstreamId: 'ups-notion',
    upstreamSlug: 'up-notion',
    code: 'upstream_5xx',
    message: 'boom',
    userId: 'u-alice',
    userEmail: 'alice@example.test',
    lane: 'stateless',
    clientName: 'claude-ai'
  }

  it('appears only when showLane is set', () => {
    const { unmount } = wrap(<ErrorsTable rows={[row]} range="30d" showLane />)
    expect(screen.getByText('Lane')).toBeInTheDocument()
    expect(screen.getByText('stateless')).toBeInTheDocument()
    unmount()

    wrap(<ErrorsTable rows={[row]} range="30d" />)
    expect(screen.queryByText('Lane')).not.toBeInTheDocument()
    expect(screen.queryByText('stateless')).not.toBeInTheDocument()
  })

  it('shows rows from before lane tracking as unknown', () => {
    wrap(<ErrorsTable rows={[{ ...row, lane: null, clientName: null }]} range="30d" showLane />)
    expect(screen.getByText('unknown')).toBeInTheDocument()
  })
})
