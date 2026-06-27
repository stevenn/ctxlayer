import { useCallback, useEffect, useState } from 'react'
import { Alert, Drawer, Stack, Text } from '@mantine/core'
import type { AdminGitSourceRow, ProductRef, TeamRef } from '@ctxlayer/shared'
import {
  adminDeleteGitSharedCredential,
  adminDeleteGitSource,
  adminDeleteGitSourceOAuth,
  adminPatchGitSource,
  adminPutGitSharedCredential,
  adminPutGitSourceOAuth,
  adminPutGitSourceVisibility,
  adminSyncGitSource,
  deleteGitUserCredential,
  fetchAdminGitSource,
  fetchProducts,
  fetchTeams
} from '../../../lib/api'
import { useBusyAction } from '../../../lib/use-busy'
import { useDrawerConfirm } from '../../../lib/dialogs'
import { explain } from './helpers'
import { DetailsSection } from './DetailsSection'
import { SyncSection } from './SyncSection'
import { OAuthSection } from './OAuthSection'
import { VisibilitySection } from './VisibilitySection'

export function GitSourceDrawer({
  sourceId,
  onClose,
  onChanged,
  onDeleted
}: {
  sourceId: string
  onClose: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const { hidden, confirm, reveal } = useDrawerConfirm()
  const [row, setRow] = useState<AdminGitSourceRow | null>(null)
  const [teams, setTeams] = useState<TeamRef[] | null>(null)
  const [products, setProducts] = useState<ProductRef[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { busy, run: withBusy } = useBusyAction({
    explain,
    setError,
    // a delete that hid the drawer then failed must show the error
    onError: reveal
  })

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const r = await fetchAdminGitSource(sourceId, signal)
      if (!signal?.aborted) setRow(r)
    },
    [sourceId]
  )

  useEffect(() => {
    const ctrl = new AbortController()
    Promise.all([reload(ctrl.signal), fetchTeams(ctrl.signal), fetchProducts(ctrl.signal)]).then(
      ([, t, p]) => {
        if (ctrl.signal.aborted) return
        setTeams(t)
        setProducts(p)
      },
      (err) => {
        if (!ctrl.signal.aborted) setError(explain(err))
      }
    )
    return () => ctrl.abort()
  }, [reload])

  if (!row) {
    return (
      <Drawer
        opened={!hidden}
        onClose={onClose}
        title="Loading…"
        position="right"
        size="lg"
        padding="md"
      >
        {error ? <Alert color="red">{error}</Alert> : <Text c="dimmed">Loading…</Text>}
      </Drawer>
    )
  }

  return (
    <Drawer
      opened={!hidden}
      onClose={onClose}
      title={`Git source · ${row.displayName}`}
      position="right"
      size="lg"
      padding="md"
    >
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        {notice && (
          <Alert
            color="blue"
            variant="light"
            radius="sm"
            withCloseButton
            onClose={() => setNotice(null)}
          >
            {notice}
          </Alert>
        )}

        <DetailsSection
          row={row}
          products={products}
          busy={busy}
          onSave={(patch) =>
            withBusy(async () => {
              await adminPatchGitSource(sourceId, patch)
              await reload()
              onChanged()
            }, 'Save')
          }
          onDelete={() =>
            withBusy(async () => {
              const ok = await confirm(
                {
                  title: 'Delete git source?',
                  message: `Delete git source "${row.displayName}"? Synced docs stay as ordinary docs, but lose their git link.`,
                  confirmLabel: 'Delete',
                  danger: true
                },
                { keepHiddenOnConfirm: true }
              )
              if (!ok) return
              await adminDeleteGitSource(sourceId)
              onDeleted()
            }, 'Delete')
          }
        />

        <SyncSection
          row={row}
          busy={busy}
          onSetToken={(token) =>
            withBusy(async () => {
              await adminPutGitSharedCredential(sourceId, { token })
              await reload()
              onChanged()
            }, 'Save token')
          }
          onClearToken={() =>
            withBusy(async () => {
              const ok = await confirm({
                title: 'Clear token?',
                message: `Clear the read token for "${row.displayName}"?`,
                confirmLabel: 'Clear',
                danger: true
              })
              if (!ok) return
              await adminDeleteGitSharedCredential(sourceId)
              await reload()
              onChanged()
            }, 'Clear token')
          }
          onSyncNow={() =>
            withBusy(async () => {
              await adminSyncGitSource(sourceId)
              setNotice('Sync queued — refresh in a moment to see updated counts.')
            }, 'Sync')
          }
        />

        <OAuthSection
          row={row}
          busy={busy}
          onSave={(cfg) =>
            withBusy(async () => {
              await adminPutGitSourceOAuth(sourceId, cfg)
              await reload()
              onChanged()
            }, 'Save OAuth')
          }
          onClear={() =>
            withBusy(async () => {
              const ok = await confirm({
                title: 'Clear OAuth config?',
                message: `Remove the OAuth client config for "${row.displayName}"? Users fall back to paste-a-PAT.`,
                confirmLabel: 'Clear',
                danger: true
              })
              if (!ok) return
              await adminDeleteGitSourceOAuth(sourceId)
              await reload()
              onChanged()
            }, 'Clear OAuth')
          }
          onDisconnect={() =>
            withBusy(async () => {
              const ok = await confirm({
                title: 'Disconnect?',
                message: `Clear your stored OAuth token for "${row.displayName}"? You can reconnect to re-authorize (e.g. under a corrected scope).`,
                confirmLabel: 'Disconnect',
                danger: true
              })
              if (!ok) return
              await deleteGitUserCredential(sourceId)
              await reload()
              onChanged()
            }, 'Disconnect')
          }
        />

        <VisibilitySection
          row={row}
          teams={teams}
          products={products}
          busy={busy}
          onSave={(rules) =>
            withBusy(async () => {
              await adminPutGitSourceVisibility(sourceId, { rules })
              await reload()
              onChanged()
            }, 'Save visibility')
          }
        />
      </Stack>
    </Drawer>
  )
}
