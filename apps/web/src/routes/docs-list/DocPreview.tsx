import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Badge, Button, Group, Loader, Stack, Text, Title, Tooltip } from '@mantine/core'
import type { DocContent, DocDetail } from '@ctxlayer/shared'
import { ApiError, fetchDoc, fetchDocContent } from '../../lib/api'
import { explain, formatRelative } from './helpers'

// The BlockNote renderer lives in its own chunk so the browse route doesn't
// ship the editor stack until a doc is actually previewed.
const DocPreviewBody = lazy(() =>
  import('./DocPreviewBody').then((m) => ({ default: m.DocPreviewBody }))
)

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; doc: DocDetail; content: DocContent }
  | { kind: 'error'; message: string }

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 24,
        textAlign: 'center'
      }}
    >
      <Text c="dimmed" fz="sm">
        {children}
      </Text>
    </div>
  )
}

/**
 * Read-only preview pane for the docs workspace. Loads the selected doc's
 * detail + last-saved content and renders it without opening a collab
 * session. Editing is a deliberate, separate action: the Edit button (shown
 * only to editors) navigates to the full-screen editor at /app/docs/:id/edit.
 */
export function DocPreview({ docId }: { docId: string | null }) {
  const nav = useNavigate()
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    if (!docId) {
      setState({ kind: 'idle' })
      return
    }
    const ctrl = new AbortController()
    setState({ kind: 'loading' })
    void (async () => {
      try {
        const [doc, content] = await Promise.all([
          fetchDoc(docId, ctrl.signal),
          fetchDocContent(docId, ctrl.signal)
        ])
        if (ctrl.signal.aborted) return
        setState({ kind: 'ready', doc, content })
      } catch (err) {
        if (ctrl.signal.aborted) return
        if (err instanceof ApiError && err.status === 404) {
          setState({ kind: 'error', message: 'This doc does not exist or was deleted.' })
          return
        }
        setState({ kind: 'error', message: explain(err) })
      }
    })()
    return () => ctrl.abort()
  }, [docId])

  if (state.kind === 'idle') return <Placeholder>Select a document to preview.</Placeholder>
  if (state.kind === 'loading') return <Placeholder>Loading…</Placeholder>
  if (state.kind === 'error') {
    return (
      <div style={{ padding: 12 }}>
        <Alert color="red" variant="light" radius="sm">
          {state.message}
        </Alert>
      </div>
    )
  }

  const { doc, content } = state
  const isGit = doc.gitSourceId != null
  return (
    <Stack gap={0} style={{ height: '100%', minHeight: 0 }}>
      <Group
        justify="space-between"
        align="flex-start"
        wrap="nowrap"
        gap="sm"
        style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}
      >
        <div style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Title
              order={3}
              fz={16}
              fw={600}
              lh={1.2}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={doc.title}
            >
              {doc.title}
            </Title>
            {isGit && (
              <Tooltip label="Synced from a git repo">
                <Badge color="grape" variant="light" size="xs">
                  git
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Text c="dimmed" fz="xs">
            {doc.docType ? `${doc.docType} · ` : ''}
            Updated {formatRelative(doc.updatedAt)} · last saved version
          </Text>
        </div>
        {doc.canEdit && (
          <Button size="xs" onClick={() => nav(`/app/docs/${doc.id}/edit`)}>
            Edit
          </Button>
        )}
      </Group>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Suspense
          fallback={
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <Loader size="sm" />
            </div>
          }
        >
          <DocPreviewBody key={doc.id} docId={doc.id} blocks={content.blocks} isGit={isGit} />
        </Suspense>
      </div>
    </Stack>
  )
}
