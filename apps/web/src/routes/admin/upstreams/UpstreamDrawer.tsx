import { useCallback, useEffect, useState } from 'react'
import { Alert, Drawer, Stack, Text } from '@mantine/core'
import type { AdminUpstreamRow, ProductRef, RoleRef, TeamRef } from '@ctxlayer/shared'
import {
  adminDeleteSharedCredentials,
  adminDeleteUpstream,
  adminPatchUpstream,
  adminPutSharedCredentials,
  adminPutUpstreamVisibility,
  adminRefreshUpstreamTools,
  deleteUpstreamCredentials,
  fetchAdminUpstream,
  fetchProducts,
  fetchRoles,
  fetchTeams,
  putUpstreamCredentials
} from '../../../lib/api'
import { useDialogs } from '../../../lib/dialogs'
import { explain } from './helpers'
import { ConnectionSection } from './ConnectionSection'
import { DetailsSection } from './DetailsSection'
import { ToolsCacheSection } from './ToolsCacheSection'
import { ToolAccessSection } from './ToolAccessSection'
import { VisibilitySection } from './VisibilitySection'

export function UpstreamDrawer({
  upstreamId,
  onClose,
  onChanged,
  onDeleted
}: {
  upstreamId: string
  onClose: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const dialogs = useDialogs()
  const [row, setRow] = useState<AdminUpstreamRow | null>(null)
  const [teams, setTeams] = useState<TeamRef[] | null>(null)
  const [products, setProducts] = useState<ProductRef[] | null>(null)
  const [roles, setRoles] = useState<RoleRef[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const r = await fetchAdminUpstream(upstreamId, signal)
      if (!signal?.aborted) setRow(r)
    },
    [upstreamId]
  )

  useEffect(() => {
    const ctrl = new AbortController()
    Promise.all([
      reload(ctrl.signal),
      fetchTeams(ctrl.signal),
      fetchProducts(ctrl.signal),
      fetchRoles(ctrl.signal)
    ]).then(
      ([_, t, p, r]) => {
        if (ctrl.signal.aborted) return
        setTeams(t)
        setProducts(p)
        setRoles(r)
      },
      (err) => {
        if (!ctrl.signal.aborted) setError(explain(err))
      }
    )
    return () => ctrl.abort()
  }, [reload])

  async function withBusy(fn: () => Promise<void>, label: string) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(`${label} failed: ${explain(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!row) {
    return (
      <Drawer opened onClose={onClose} title="Loading…" position="right" size="lg" padding="md">
        {error ? <Alert color="red">{error}</Alert> : <Text c="dimmed">Loading…</Text>}
      </Drawer>
    )
  }

  return (
    <Drawer
      opened
      onClose={onClose}
      title={`Upstream · ${row.displayName}`}
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

        <DetailsSection
          row={row}
          busy={busy}
          onSave={(patch) =>
            withBusy(async () => {
              await adminPatchUpstream(upstreamId, patch)
              await reload()
              onChanged()
            }, 'Save')
          }
          onDelete={() =>
            withBusy(async () => {
              const ok = await dialogs.confirm({
                title: 'Delete upstream?',
                message: `Delete upstream "${row.displayName}"? All cached tools, visibility rules, and per-user credentials for this upstream will be removed.`,
                confirmLabel: 'Delete',
                danger: true
              })
              if (!ok) return
              await adminDeleteUpstream(upstreamId)
              onDeleted()
            }, 'Delete')
          }
        />

        <VisibilitySection
          row={row}
          teams={teams}
          products={products}
          roles={roles}
          busy={busy}
          onSave={(rules) =>
            withBusy(async () => {
              await adminPutUpstreamVisibility(upstreamId, { rules })
              await reload()
              onChanged()
            }, 'Save visibility')
          }
        />

        <ConnectionSection
          row={row}
          busy={busy}
          onSaveBearer={(token) =>
            withBusy(async () => {
              await putUpstreamCredentials(upstreamId, { token })
              await reload()
              onChanged()
            }, 'Save bearer')
          }
          onDisconnect={() =>
            withBusy(async () => {
              const ok = await dialogs.confirm({
                title: 'Disconnect upstream?',
                message: `Disconnect your credentials for "${row.displayName}"? You'll need to ${
                  row.authStrategy === 'user_oauth' ? 'reauthorize' : 'paste a new token'
                } before Refresh works again.`,
                confirmLabel: 'Disconnect',
                danger: true
              })
              if (!ok) return
              await deleteUpstreamCredentials(upstreamId)
              await reload()
              onChanged()
            }, 'Disconnect')
          }
          onSaveShared={(token) =>
            withBusy(async () => {
              await adminPutSharedCredentials(upstreamId, { token })
              await reload()
              onChanged()
            }, 'Save shared token')
          }
          onClearShared={() =>
            withBusy(async () => {
              const ok = await dialogs.confirm({
                title: 'Clear shared token?',
                message: `Clear the shared token for "${row.displayName}"? Every user of this upstream loses access until a new token is configured.`,
                confirmLabel: 'Clear',
                danger: true
              })
              if (!ok) return
              await adminDeleteSharedCredentials(upstreamId)
              await reload()
              onChanged()
            }, 'Clear shared token')
          }
        />

        <ToolsCacheSection
          row={row}
          busy={busy}
          onRefresh={() =>
            withBusy(async () => {
              await adminRefreshUpstreamTools(upstreamId)
              await reload()
              onChanged()
            }, 'Refresh tools')
          }
        />

        <ToolAccessSection
          upstreamId={upstreamId}
          teams={teams}
          products={products}
          roles={roles}
        />
      </Stack>
    </Drawer>
  )
}
