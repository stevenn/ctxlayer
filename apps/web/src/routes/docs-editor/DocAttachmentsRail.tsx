import { useState } from 'react'
import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import type { DocAttachmentRef } from '@ctxlayer/shared'
import {
  attachDoc,
  detachDoc,
  fetchDocAttachments,
  fetchUpstreams,
  fetchUserUpstreamTools
} from '../../lib/api'
import { useLoad } from '../../lib/use-load'
import { useDialogs } from '../../lib/dialogs'
import { explain } from './helpers'

/**
 * Right-rail section showing which upstreams (and optionally which
 * specific tool on those upstreams) this doc is attached to. Reads
 * are open; mutations require admin (canManage).
 */
export function DocAttachmentsRail({ docId, canManage }: { docId: string; canManage: boolean }) {
  const dialogs = useDialogs()
  const {
    data: items,
    error,
    reload
  } = useLoad(() => fetchDocAttachments(docId), [docId], {
    explain
  })
  const [attachOpen, setAttachOpen] = useState(false)

  async function onDetach(a: DocAttachmentRef) {
    const ok = await dialogs.confirm({
      title: 'Detach from upstream?',
      message: `Remove the attachment to ${a.upstreamSlug}${a.toolName ? `.${a.toolName}` : ''}?`,
      confirmLabel: 'Detach',
      danger: true
    })
    if (!ok) return
    try {
      await detachDoc({
        docId,
        upstreamId: a.upstreamId,
        toolName: a.toolName || undefined
      })
      await reload()
    } catch (err) {
      await dialogs.alert({ title: 'Detach failed', message: explain(err) })
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          marginBottom: 6
        }}
      >
        Attached to upstreams
      </div>
      {error && (
        <Text fz="xs" c="red">
          {error}
        </Text>
      )}
      {items === null && !error && (
        <Text fz="xs" c="dimmed">
          Loading…
        </Text>
      )}
      {items && items.length === 0 && (
        <Text fz="xs" c="dimmed">
          Not attached to any upstream.
        </Text>
      )}
      {items && items.length > 0 && (
        <Stack gap={4}>
          {items.map((a) => (
            <Group
              key={`${a.upstreamId}/${a.toolName}`}
              justify="space-between"
              gap="xs"
              wrap="nowrap"
              style={{
                padding: '4px 6px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)'
              }}
            >
              <Text fz="xs" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <code>{a.upstreamSlug}</code>
                {a.toolName ? (
                  <>
                    {' · '}
                    <code>{a.toolName}</code>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-dim)' }}> (whole upstream)</span>
                )}
              </Text>
              {canManage && (
                <Button size="xs" variant="subtle" color="red" onClick={() => void onDetach(a)}>
                  ×
                </Button>
              )}
            </Group>
          ))}
        </Stack>
      )}
      {canManage && (
        <Group justify="flex-end" mt="xs">
          <Button size="xs" variant="default" onClick={() => setAttachOpen(true)}>
            Attach to upstream
          </Button>
        </Group>
      )}
      {attachOpen && (
        <DocAttachToUpstreamModal
          docId={docId}
          onClose={() => setAttachOpen(false)}
          onAttached={async () => {
            setAttachOpen(false)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function DocAttachToUpstreamModal({
  docId,
  onClose,
  onAttached
}: {
  docId: string
  onClose: () => void
  onAttached: () => void
}) {
  const [selectedUpstreamId, setSelectedUpstreamId] = useState<string | null>(null)
  const [selectedTool, setSelectedTool] = useState<string>('')
  const [busy, setBusy] = useState(false)
  // One error channel shared by the loads and the attach action.
  const [error, setError] = useState<string | null>(null)

  const { data: upstreams } = useLoad((signal) => fetchUpstreams(signal), [], {
    explain,
    onError: setError
  })

  const { data: tools } = useLoad(
    async (signal) => {
      if (!selectedUpstreamId) {
        setSelectedTool('')
        return []
      }
      const resp = await fetchUserUpstreamTools(selectedUpstreamId, signal)
      if (!signal?.aborted) setSelectedTool('')
      return [
        { value: '', label: '— whole upstream —' },
        ...resp.tools.map((t) => ({ value: t.toolName, label: t.toolName }))
      ]
    },
    [selectedUpstreamId],
    { explain, onError: setError }
  )

  async function submit() {
    if (!selectedUpstreamId) return
    setBusy(true)
    setError(null)
    try {
      await attachDoc({
        docId,
        upstreamId: selectedUpstreamId,
        toolName: selectedTool || undefined
      })
      onAttached()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  const upstreamOptions = (upstreams ?? []).map((u) => ({
    value: u.id,
    label: `${u.displayName} (${u.slug})`
  }))

  return (
    <Modal opened onClose={onClose} title="Attach doc to upstream" size="md">
      <Stack gap="md">
        {error && (
          <Text fz="sm" c="red">
            {error}
          </Text>
        )}
        <select
          value={selectedUpstreamId ?? ''}
          onChange={(e) => setSelectedUpstreamId(e.currentTarget.value || null)}
          disabled={!upstreams || busy}
          style={{ padding: 6 }}
        >
          <option value="">Pick an upstream…</option>
          {upstreamOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={selectedTool}
          onChange={(e) => setSelectedTool(e.currentTarget.value)}
          disabled={!selectedUpstreamId || busy}
          style={{ padding: 6 }}
        >
          {(tools ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!selectedUpstreamId}>
            Attach
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
