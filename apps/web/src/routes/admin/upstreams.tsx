import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Group,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import type {
  AdminUpstreamRow,
  AuthStrategy,
  ProductRef,
  SupportedTransport,
  TeamRef,
  VisibilityRulePayload
} from '@ctxlayer/shared'
import {
  ApiError,
  ApiSchemaError,
  adminCreateUpstream,
  adminDeleteUpstream,
  adminPatchUpstream,
  adminPutUpstreamVisibility,
  adminRefreshUpstreamTools,
  deleteUpstreamCredentials,
  fetchAdminUpstream,
  fetchAdminUpstreams,
  fetchProducts,
  fetchTeams,
  putUpstreamCredentials
} from '../../lib/api'

const TRANSPORT_OPTIONS: { value: SupportedTransport; label: string }[] = [
  { value: 'streamable_http', label: 'Streamable HTTP (current MCP spec)' },
  { value: 'sse', label: 'SSE (legacy)' }
]

const AUTH_OPTIONS: {
  value: AuthStrategy
  label: string
  description: string
  enabled: boolean
}[] = [
  {
    value: 'none',
    label: 'None',
    description: 'Upstream needs no credentials. Admin can refresh tools immediately.',
    enabled: true
  },
  {
    value: 'user_bearer',
    label: 'User bearer (personal token)',
    description: 'Each user pastes their own token on /upstreams.',
    enabled: true
  },
  {
    value: 'shared_bearer',
    label: 'Shared bearer',
    description: 'A single token used for all users. Storage lands in M5.',
    enabled: false
  },
  {
    value: 'user_oauth',
    label: 'User OAuth (DCR + PKCE)',
    description:
      'Each user authorises at the upstream. ctxlayer dynamically registers itself and transparently refreshes.',
    enabled: true
  }
]

export function AdminUpstreams() {
  const [items, setItems] = useState<AdminUpstreamRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [oauthBanner, setOauthBanner] = useState<{ kind: 'ok' | 'err'; message: string } | null>(
    null
  )

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await fetchAdminUpstreams(signal)
      if (!signal?.aborted) setItems(list)
    } catch (err) {
      if (!signal?.aborted) setError(explain(err))
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    reload(ctrl.signal)
    return () => ctrl.abort()
  }, [reload])

  // OAuth callbacks bounced via `return_to=admin` flash a slug or
  // an error code on the URL; surface it and clean the URL.
  useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('oauth_connected')
    const errCode = params.get('oauth_error')
    if (connected) {
      setOauthBanner({ kind: 'ok', message: `Connected ${connected}.` })
    } else if (errCode) {
      const desc = params.get('desc') ?? ''
      setOauthBanner({
        kind: 'err',
        message: `OAuth failed: ${errCode}${desc ? ` — ${desc}` : ''}`
      })
    }
    if (connected || errCode) {
      params.delete('oauth_connected')
      params.delete('oauth_error')
      params.delete('desc')
      const qs = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
    }
  }, [])

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Upstreams
        </Title>
        <Button onClick={() => setCreateOpen(true)}>+ New upstream</Button>
      </Group>

      {oauthBanner && (
        <Alert
          color={oauthBanner.kind === 'ok' ? 'green' : 'red'}
          variant="light"
          radius="sm"
          mb="md"
          withCloseButton
          onClose={() => setOauthBanner(null)}
        >
          {oauthBanner.message}
        </Alert>
      )}
      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {!items && !error && <Text c="dimmed">Loading…</Text>}

      {items && items.length === 0 && (
        <Text c="dimmed">
          No upstreams yet. Click <strong>+ New upstream</strong> to register
          the first one (e.g. Notion HTTP MCP).
        </Text>
      )}

      {items && items.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Display name</th>
              <th>Slug</th>
              <th>Transport</th>
              <th>Auth</th>
              <th>Tools</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id} onClick={() => setEditingId(u.id)}>
                <td style={{ fontWeight: 500 }}>{u.displayName}</td>
                <td className="text-muted"><code>{u.slug}</code></td>
                <td className="text-muted">{u.transport}</td>
                <td className="text-muted">{u.authStrategy}</td>
                <td className="text-muted">{u.toolsCount}</td>
                <td>
                  <Badge color={u.enabled ? 'green' : 'gray'} variant="light">
                    {u.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateUpstreamModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false)
          reload()
          setEditingId(id)
        }}
      />

      {editingId && (
        <UpstreamDrawer
          upstreamId={editingId}
          onClose={() => setEditingId(null)}
          onChanged={() => reload()}
          onDeleted={() => {
            setEditingId(null)
            reload()
          }}
        />
      )}
    </>
  )
}

// ----- Create modal ------------------------------------------------------

function CreateUpstreamModal({
  opened,
  onClose,
  onCreated
}: {
  opened: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [slug, setSlug] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [transport, setTransport] = useState<SupportedTransport>('streamable_http')
  const [url, setUrl] = useState('')
  const [authStrategy, setAuthStrategy] = useState<AuthStrategy>('user_bearer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) {
      setSlug('')
      setDisplayName('')
      setTransport('streamable_http')
      setUrl('')
      setAuthStrategy('user_bearer')
      setError(null)
    }
  }, [opened])

  async function submit() {
    if (!slug.trim() || !displayName.trim() || !url.trim()) return
    setBusy(true)
    setError(null)
    try {
      const created = await adminCreateUpstream({
        slug: slug.trim(),
        displayName: displayName.trim(),
        transport,
        url: url.trim(),
        authStrategy,
        enabled: true
      })
      onCreated(created.id)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New upstream" centered size="lg">
      <Stack gap="md">
        <TextInput
          label="Display name"
          placeholder="Notion"
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
        />
        <TextInput
          label="Slug"
          placeholder="notion"
          description="Used in tool namespacing — agents see notion__search_pages. Lowercase letter then [a-z0-9_], max 24."
          value={slug}
          onChange={(e) => setSlug(e.currentTarget.value)}
        />
        <Select
          label="Transport"
          data={TRANSPORT_OPTIONS}
          value={transport}
          onChange={(v) => v && setTransport(v as SupportedTransport)}
          allowDeselect={false}
        />
        <TextInput
          label="Upstream MCP URL"
          placeholder="https://mcp.notion.com/mcp"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
        />
        <Select
          label="Auth strategy"
          data={AUTH_OPTIONS.map((o) => ({
            value: o.value,
            label: o.enabled ? o.label : `${o.label} (M5)`,
            disabled: !o.enabled
          }))}
          value={authStrategy}
          onChange={(v) => v && setAuthStrategy(v as AuthStrategy)}
          allowDeselect={false}
          description={AUTH_OPTIONS.find((o) => o.value === authStrategy)?.description}
        />
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={busy}
            disabled={!slug.trim() || !displayName.trim() || !url.trim()}
          >
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ----- Edit drawer -------------------------------------------------------

function UpstreamDrawer({
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
  const [row, setRow] = useState<AdminUpstreamRow | null>(null)
  const [teams, setTeams] = useState<TeamRef[] | null>(null)
  const [products, setProducts] = useState<ProductRef[] | null>(null)
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
    Promise.all([reload(ctrl.signal), fetchTeams(ctrl.signal), fetchProducts(ctrl.signal)]).then(
      ([_, t, p]) => {
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
      <Drawer
        opened
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
              if (
                !confirm(
                  `Delete upstream "${row.displayName}"? All cached tools, visibility rules, and per-user credentials for this upstream will be removed.`
                )
              ) {
                return
              }
              await adminDeleteUpstream(upstreamId)
              onDeleted()
            }, 'Delete')
          }
        />

        <VisibilitySection
          row={row}
          teams={teams}
          products={products}
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
              if (
                !confirm(
                  `Disconnect your credentials for "${row.displayName}"? You'll need to ${
                    row.authStrategy === 'user_oauth' ? 'reauthorize' : 'paste a new token'
                  } before Refresh works again.`
                )
              ) {
                return
              }
              await deleteUpstreamCredentials(upstreamId)
              await reload()
              onChanged()
            }, 'Disconnect')
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
      </Stack>
    </Drawer>
  )
}

function DetailsSection({
  row,
  busy,
  onSave,
  onDelete
}: {
  row: AdminUpstreamRow
  busy: boolean
  onSave: (patch: {
    displayName?: string
    transport?: SupportedTransport
    url?: string
    authStrategy?: AuthStrategy
    enabled?: boolean
  }) => void
  onDelete: () => void
}) {
  const [displayName, setDisplayName] = useState(row.displayName)
  const [transport, setTransport] = useState<SupportedTransport>(row.transport)
  const [url, setUrl] = useState(row.url)
  const [authStrategy, setAuthStrategy] = useState<AuthStrategy>(row.authStrategy)
  const [enabled, setEnabled] = useState(row.enabled)

  // Reset when the row changes (e.g. after save → reload).
  useEffect(() => {
    setDisplayName(row.displayName)
    setTransport(row.transport)
    setUrl(row.url)
    setAuthStrategy(row.authStrategy)
    setEnabled(row.enabled)
  }, [row])

  return (
    <Section title="Details">
      <Stack gap="xs">
        <TextInput
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
        />
        <TextInput
          label="Slug"
          value={row.slug}
          disabled
          description="Slugs can't be renamed — agents would lose tool references."
        />
        <Select
          label="Transport"
          data={TRANSPORT_OPTIONS}
          value={transport}
          onChange={(v) => v && setTransport(v as SupportedTransport)}
          allowDeselect={false}
        />
        <TextInput
          label="Upstream MCP URL"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
        />
        <Select
          label="Auth strategy"
          data={AUTH_OPTIONS.map((o) => ({
            value: o.value,
            label: o.enabled ? o.label : `${o.label} (M5)`,
            disabled: !o.enabled
          }))}
          value={authStrategy}
          onChange={(v) => v && setAuthStrategy(v as AuthStrategy)}
          allowDeselect={false}
          description={AUTH_OPTIONS.find((o) => o.value === authStrategy)?.description}
        />
        <Switch
          label="Enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
          description="Disabled upstreams are hidden from /upstreams and never appear in tools/list."
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" color="red" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
          <Button
            onClick={() =>
              onSave({ displayName, transport, url, authStrategy, enabled })
            }
            loading={busy}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Section>
  )
}

function VisibilitySection({
  row,
  teams,
  products,
  busy,
  onSave
}: {
  row: AdminUpstreamRow
  teams: TeamRef[] | null
  products: ProductRef[] | null
  busy: boolean
  onSave: (rules: VisibilityRulePayload[]) => void
}) {
  // Memoise: every re-render of the parent rebuilds `row.visibility` as a
  // fresh array reference (and the helper rebuilds fresh Set instances),
  // which made the reset-on-row-change effect below fire on every toggle
  // and snap the checkboxes back. Recompute only when the visibility
  // array itself changes (i.e. after reload following a save).
  const initial = useMemo(() => deriveInitialVisibility(row.visibility), [row.visibility])
  const [everyone, setEveryone] = useState(initial.everyone)
  const [teamIds, setTeamIds] = useState(initial.teamIds)
  const [productIds, setProductIds] = useState(initial.productIds)

  useEffect(() => {
    setEveryone(initial.everyone)
    setTeamIds(initial.teamIds)
    setProductIds(initial.productIds)
  }, [initial])

  const dirty =
    everyone !== initial.everyone ||
    !setsEqual(teamIds, initial.teamIds) ||
    !setsEqual(productIds, initial.productIds)

  const save = () => {
    const rules: VisibilityRulePayload[] = []
    if (everyone) rules.push({ scopeKind: 'everyone', scopeId: null })
    for (const id of teamIds) rules.push({ scopeKind: 'team', scopeId: id })
    for (const id of productIds) rules.push({ scopeKind: 'product', scopeId: id })
    onSave(rules)
  }

  return (
    <Section title="Visibility">
      <Text fz="xs" c="dimmed" mb={6}>
        Additive rules — a user sees this upstream if any rule grants access.
        Empty rule set = invisible to everyone.
      </Text>
      <Stack gap="sm">
        <Checkbox
          label="Everyone signed in"
          checked={everyone}
          onChange={(e) => setEveryone(e.currentTarget.checked)}
        />

        <SubSection title="Teams">
          {!teams && <Text c="dimmed" fz="xs">Loading…</Text>}
          {teams && teams.length === 0 && (
            <Text c="dimmed" fz="xs">No teams yet — create some on Admin · Teams.</Text>
          )}
          {teams && teams.length > 0 && (
            <Stack gap={4}>
              {teams.map((t) => (
                <Checkbox
                  key={t.id}
                  label={t.displayName}
                  checked={teamIds.has(t.id)}
                  onChange={(e) =>
                    setTeamIds(toggleId(teamIds, t.id, e.currentTarget.checked))
                  }
                />
              ))}
            </Stack>
          )}
        </SubSection>

        <SubSection title="Products">
          {!products && <Text c="dimmed" fz="xs">Loading…</Text>}
          {products && products.length === 0 && (
            <Text c="dimmed" fz="xs">No products yet — create some on Admin · Products.</Text>
          )}
          {products && products.length > 0 && (
            <Stack gap={4}>
              {products.map((p) => (
                <Checkbox
                  key={p.id}
                  label={p.displayName}
                  checked={productIds.has(p.id)}
                  onChange={(e) =>
                    setProductIds(toggleId(productIds, p.id, e.currentTarget.checked))
                  }
                />
              ))}
            </Stack>
          )}
        </SubSection>

        <Group justify="flex-end" gap="xs">
          <Button onClick={save} loading={busy} disabled={!dirty}>
            Save visibility
          </Button>
        </Group>
      </Stack>
    </Section>
  )
}

function ConnectionSection({
  row,
  busy,
  onSaveBearer,
  onDisconnect
}: {
  row: AdminUpstreamRow
  busy: boolean
  onSaveBearer: (token: string) => void
  onDisconnect: () => void
}) {
  const [token, setToken] = useState('')

  const isUserBearer = row.authStrategy === 'user_bearer'
  const isUserOauth = row.authStrategy === 'user_oauth'
  const isShared = row.authStrategy === 'shared_bearer'
  const isNone = row.authStrategy === 'none'

  // Admin clicks Connect → OAuth start with return_to=admin so the
  // callback lands back here instead of /upstreams. Full-page nav
  // because OAuth needs real browser redirects.
  const startOauth = () => {
    window.location.assign(
      `/api/upstreams/${encodeURIComponent(row.id)}/oauth/start?return_to=admin`
    )
  }

  return (
    <Section title="Your connection">
      <Stack gap="xs">
        <Group gap="xs">
          <Text fz="xs" c="dimmed">Status</Text>
          <Badge
            color={row.currentUserConnected ? 'green' : 'gray'}
            variant={row.currentUserConnected ? 'filled' : 'light'}
          >
            {row.currentUserConnected ? 'connected' : 'not connected'}
          </Badge>
        </Group>

        {isNone && (
          <Text fz="xs" c="dimmed">
            This upstream uses <code>none</code> auth — no per-user
            credentials needed. Refresh and tool calls work for everyone
            with visibility, no setup required.
          </Text>
        )}

        {isShared && (
          <Alert color="gray" variant="light" radius="sm">
            <Text fz="xs">
              Shared-bearer credential storage lands in M5 phase 2. Until
              then, this strategy has no working credential path.
            </Text>
          </Alert>
        )}

        {isUserBearer && (
          <Stack gap="xs">
            <PasswordInput
              size="xs"
              placeholder={
                row.currentUserConnected
                  ? 'Paste a new token to replace the stored one…'
                  : 'Paste a personal access token…'
              }
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              {row.currentUserConnected && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={onDisconnect}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              )}
              <Button
                size="xs"
                onClick={() => {
                  if (!token.trim()) return
                  onSaveBearer(token.trim())
                  setToken('')
                }}
                disabled={!token.trim() || busy}
              >
                {row.currentUserConnected ? 'Replace token' : 'Connect'}
              </Button>
            </Group>
          </Stack>
        )}

        {isUserOauth && (
          <Stack gap="xs">
            <Text fz="xs" c="dimmed">
              Connect signs you in at the upstream via OAuth (PKCE).
              ctxlayer stores the refresh token sealed at rest and
              transparently refreshes the access token as needed. The
              callback lands back here on this admin page.
            </Text>
            <Group justify="flex-end" gap="xs">
              {row.currentUserConnected && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={onDisconnect}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              )}
              <Button size="xs" onClick={startOauth} disabled={busy}>
                {row.currentUserConnected ? 'Reconnect' : 'Connect with OAuth'}
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Section>
  )
}

function ToolsCacheSection({
  row,
  busy,
  onRefresh
}: {
  row: AdminUpstreamRow
  busy: boolean
  onRefresh: () => void
}) {
  const cachedAt = row.toolsCachedAt
    ? new Date(row.toolsCachedAt * 1000).toLocaleString()
    : 'never'
  const needsAdminConnection =
    row.authStrategy === 'user_bearer' || row.authStrategy === 'user_oauth'

  return (
    <Section title="Tool catalogue cache">
      <Stack gap={6}>
        <Group gap="md">
          <div>
            <Text fz="xs" c="dimmed">Cached tools</Text>
            <Text fw={600} fz="lg">{row.toolsCount}</Text>
          </div>
          <div>
            <Text fz="xs" c="dimmed">Last refreshed</Text>
            <Text fz="sm">{cachedAt}</Text>
          </div>
        </Group>
        {needsAdminConnection && (
          <Alert color="gray" variant="light" radius="sm">
            <Text fz="xs">
              Refresh uses <strong>your own</strong> connection. If you
              haven't{' '}
              {row.authStrategy === 'user_oauth'
                ? 'completed the OAuth flow'
                : 'pasted a token'}{' '}
              for this upstream on <code>/upstreams</code> yet, do that
              first.
            </Text>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button
            size="xs"
            variant="default"
            onClick={onRefresh}
            disabled={busy}
          >
            Refresh now
          </Button>
        </Group>
      </Stack>
    </Section>
  )
}

// ----- helpers -----------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
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
        {title}
      </div>
      {children}
    </div>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Text fz="xs" fw={500} mb={4}>
        {title}
      </Text>
      {children}
    </div>
  )
}

function deriveInitialVisibility(rules: VisibilityRulePayload[]): {
  everyone: boolean
  teamIds: Set<string>
  productIds: Set<string>
} {
  const teamIds = new Set<string>()
  const productIds = new Set<string>()
  let everyone = false
  for (const r of rules) {
    if (r.scopeKind === 'everyone') everyone = true
    else if (r.scopeKind === 'team' && r.scopeId) teamIds.add(r.scopeId)
    else if (r.scopeKind === 'product' && r.scopeId) productIds.add(r.scopeId)
  }
  return { everyone, teamIds, productIds }
}

function toggleId(current: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(current)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 401)
    return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError && err.status === 403) return 'Admin permission required.'
  if (err instanceof ApiError && err.status === 409) return 'That slug is already taken.'
  if (err instanceof ApiError && err.status === 502) {
    return apiErrorBodyMessage(err) ?? 'Upstream is unreachable or returned an error.'
  }
  if (err instanceof ApiError && err.status === 400) {
    return apiErrorBodyMessage(err) ?? 'Server rejected the request.'
  }
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  if (err instanceof Error) return err.message
  return 'Could not reach the server.'
}

/**
 * Pull a human-readable message out of an ApiError body when the
 * backend supplied one. Conventions used by ctxlayer's REST: 4xx/5xx
 * bodies look like `{error: "code", hint?: "...", message?: "..."}`.
 * We prefer `hint` (instructive) → `message` (raw) → the `error` code
 * itself (machine-y but better than nothing).
 */
function apiErrorBodyMessage(err: ApiError): string | null {
  const body = err.body as { error?: string; hint?: string; message?: string } | null | undefined
  if (!body || typeof body !== 'object') return null
  if (typeof body.hint === 'string' && body.hint) return body.hint
  if (typeof body.message === 'string' && body.message) return body.message
  if (typeof body.error === 'string' && body.error) return body.error
  return null
}
