import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import type { DocDetail, GitDocStatus } from '@ctxlayer/shared'
import { DialogProvider } from '../../lib/dialogs'
import { FolderField } from './FolderField'
import { LockIndicator } from './LockIndicator'
import { GitPanel } from './GitPanel'
import { DocLinkPicker } from './DocLinkPicker'
import { DocAttachmentsRail } from './DocAttachmentsRail'
import { CollabBadge, MetaRow, Person } from './RailMeta'

// The full DocsEditor constructs Yjs + a CollabWSProvider (WebSocket) + a
// BlockNote editor, which is impractical to mount headlessly. Instead we
// smoke-test the standalone sub-components extracted during the split with
// representative props — this verifies the extraction wired their props
// correctly (the whole point of the refactor). The api module is mocked so
// the fetch-on-mount sub-components stay inert.

vi.mock('../../lib/api', () => ({
  // FolderField / LockIndicator mutate via these on click; never called at render.
  patchDoc: vi.fn().mockResolvedValue(undefined),
  setDocLocked: vi.fn().mockResolvedValue(undefined),
  // GitPanel
  proposeGitPullRequest: vi.fn().mockResolvedValue({ outcome: 'noop' }),
  putGitUserCredential: vi.fn().mockResolvedValue(undefined),
  // DocLinkPicker fetches the doc list on mount.
  fetchDocs: vi.fn().mockResolvedValue([]),
  // DocAttachmentsRail fetches attachments on mount.
  fetchDocAttachments: vi.fn().mockResolvedValue([]),
  fetchUpstreams: vi.fn().mockResolvedValue([]),
  fetchUserUpstreamTools: vi.fn().mockResolvedValue({ tools: [] }),
  attachDoc: vi.fn().mockResolvedValue(undefined),
  detachDoc: vi.fn().mockResolvedValue(undefined)
}))

const doc: DocDetail = {
  id: 'd_1',
  title: 'Spec',
  slug: 'spec',
  kind: 'doc',
  folder: '/specs/api',
  gitSourceId: null,
  gitSourceSlug: null,
  gitSourceName: null,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_500,
  createdBy: { id: 'u_1', email: 'op@example.com', name: 'Op' },
  updatedBy: { id: 'u_1', email: 'op@example.com', name: 'Op' },
  lockedAt: null,
  lockedBy: null,
  currentRevId: 'rev_1',
  docType: null,
  description: null,
  resource: null,
  canEdit: true,
  canShare: true,
  canLock: true
}

const gitStatus: GitDocStatus = {
  gitSourceId: 'g_1',
  sourceSlug: 'acme/repo',
  provider: 'github',
  branch: 'main',
  path: 'docs/spec.md',
  webUrl: 'https://github.com/acme/repo/blob/main/docs/spec.md',
  syncState: 'clean',
  syncedAt: 1_700_000_000,
  canWrite: true,
  oauthConfigured: false,
  pr: null
}

function wrap(node: React.ReactNode) {
  return render(
    <MantineProvider>
      <DialogProvider>{node}</DialogProvider>
    </MantineProvider>
  )
}

describe('docs-editor extracted sub-components (render smoke)', () => {
  it('FolderField renders the current folder as a click-to-move control', () => {
    wrap(<FolderField doc={doc} onChanged={async () => {}} />)
    expect(screen.getByText('/specs/api')).toBeInTheDocument()
  })

  it('LockIndicator renders the lock toggle for a lock-capable user', () => {
    wrap(<LockIndicator doc={doc} onChanged={async () => {}} />)
    // Unlocked + canLock → the "Unlocked" action icon is shown.
    expect(screen.getByLabelText('Unlocked')).toBeInTheDocument()
  })

  it('GitPanel renders repo/branch + the propose-change action', () => {
    wrap(
      <GitPanel
        status={gitStatus}
        docId="d_1"
        canEdit
        getMarkdown={async () => '# md'}
        onRefresh={async () => {}}
      />
    )
    expect(screen.getByText('acme/repo')).toBeInTheDocument()
    expect(screen.getByText(/Propose change/)).toBeInTheDocument()
  })

  it('DocLinkPicker renders its modal with the search/URL input', () => {
    wrap(<DocLinkPicker currentDocId="d_1" onClose={() => {}} onPick={() => {}} />)
    expect(screen.getByText('Add link')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Search docs or paste a URL/)).toBeInTheDocument()
  })

  it('DocAttachmentsRail renders its section header', () => {
    wrap(<DocAttachmentsRail docId="d_1" canManage />)
    expect(screen.getByText('Attached to upstreams')).toBeInTheDocument()
  })

  it('RailMeta exports render: MetaRow, CollabBadge, Person', () => {
    wrap(
      <>
        <MetaRow label="Created">
          <Person u={doc.createdBy} />
        </MetaRow>
        <CollabBadge canEdit status="connected" />
      </>
    )
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByText('Op')).toBeInTheDocument()
    expect(screen.getByText('Live')).toBeInTheDocument()
  })
})
