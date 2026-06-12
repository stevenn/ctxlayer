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
  AdminGitSourceRow,
  GitCredStrategy,
  GitOAuthConfigRequest,
  GitProvider,
  GitSyncInterval,
  ProductRef,
  TeamRef,
  VisibilityRulePayload
} from '@ctxlayer/shared'
import {
  adminCreateGitSource,
  adminDeleteGitSharedCredential,
  adminDeleteGitSource,
  adminDeleteGitSourceOAuth,
  adminPatchGitSource,
  adminPutGitSharedCredential,
  adminPutGitSourceOAuth,
  adminPutGitSourceVisibility,
  adminSyncGitSource,
  fetchAdminGitSource,
  fetchAdminGitSources,
  fetchProducts,
  fetchTeams
} from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import { useDrawerConfirm } from '../../lib/dialogs'
import { parseGitUrl, type ParsedGitUrl } from '../../lib/git-url'

const STRATEGY_OPTIONS: { value: GitCredStrategy; label: string }[] = [
  { value: 'shared_bearer', label: 'Shared org token (PAT)' },
  { value: 'user_bearer', label: 'Per-user token (PAT)' },
  { value: 'user_oauth', label: 'Per-user OAuth' }
]

const INTERVAL_OPTIONS: { value: GitSyncInterval; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: '6x_daily', label: '6× daily' },
  { value: '2x_daily', label: '2× daily' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' }
]

export function AdminGitSources() {
  const [items, setItems] = useState<AdminGitSourceRow[] | null>(null)
  const [products, setProducts] = useState<ProductRef[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await fetchAdminGitSources(signal)
      if (!signal?.aborted) setItems(list)
    } catch (err) {
      if (!signal?.aborted) setError(explain(err))
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    reload(ctrl.signal)
    fetchProducts(ctrl.signal).then(
      (p) => !ctrl.signal.aborted && setProducts(p),
      () => {
        /* product names are cosmetic in the list */
      }
    )
    return () => ctrl.abort()
  }, [reload])

  const productName = (id: string | null) =>
    id ? (products?.find((p) => p.id === id)?.displayName ?? id) : '—'

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Git repos
        </Title>
        <Button onClick={() => setCreateOpen(true)}>+ New git source</Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {!items && !error && <Text c="dimmed">Loading…</Text>}
      {items && items.length === 0 && (
        <Text c="dimmed">
          No git sources yet. Click <strong>+ New git source</strong> to mirror a repo's markdown
          into the doc library.
        </Text>
      )}

      {items && items.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Display name</th>
              <th>Slug</th>
              <th>Provider</th>
              <th>Repo</th>
              <th>Branch</th>
              <th>Product</th>
              <th>Docs</th>
              <th>Last sync</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {items.map((g) => (
              <tr key={g.id} onClick={() => setEditingId(g.id)}>
                <td style={{ fontWeight: 500 }}>{g.displayName}</td>
                <td className="text-muted">
                  <code>{g.slug}</code>
                </td>
                <td className="text-muted">{g.provider}</td>
                <td className="text-muted">
                  <code style={{ fontSize: 12 }}>{repoLabel(g)}</code>
                </td>
                <td className="text-muted">{g.branch}</td>
                <td className="text-muted">{productName(g.productId)}</td>
                <td className="text-muted">{g.docCount}</td>
                <td>
                  <SyncBadge row={g} />
                </td>
                <td>
                  <Badge color={g.enabled ? 'green' : 'gray'} variant="light">
                    {g.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateGitSourceModal
        opened={createOpen}
        products={products}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false)
          reload()
          setEditingId(id)
        }}
      />

      {editingId && (
        <GitSourceDrawer
          sourceId={editingId}
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

function SyncBadge({ row }: { row: AdminGitSourceRow }) {
  if (!row.lastSyncStatus)
    return (
      <Badge variant="light" color="gray">
        never
      </Badge>
    )
  const color =
    row.lastSyncStatus === 'ok' ? 'green' : row.lastSyncStatus === 'partial' ? 'yellow' : 'red'
  return (
    <Badge variant="light" color={color} title={row.lastSyncError ?? undefined}>
      {row.lastSyncStatus}
    </Badge>
  )
}

function repoLabel(g: AdminGitSourceRow): string {
  return g.owner ? `${g.owner}/${g.repo}` : g.repo
}

// ----- Create modal ------------------------------------------------------

function CreateGitSourceModal({
  opened,
  products,
  onClose,
  onCreated
}: {
  opened: boolean
  products: ProductRef[] | null
  onClose: () => void
  onCreated: (id: string) => void
}) {
  // The repo URL drives everything — provider, host, owner, repo, and
  // (for /tree/ links) branch + folder are derived from it. Only the
  // non-derivable bits stay as fields; strategies + cadence default and
  // are editable in the drawer afterwards.
  const [url, setUrl] = useState('')
  const [parsed, setParsed] = useState<ParsedGitUrl | null>(null)
  const [branch, setBranch] = useState('main')
  const [folder, setFolder] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [slug, setSlug] = useState('')
  const [productId, setProductId] = useState<string | null>(null)
  // Once the user edits an auto-filled field, stop overwriting it.
  const [nameTouched, setNameTouched] = useState(false)
  const [slugTouched, setSlugTouched] = useState(false)
  const [branchTouched, setBranchTouched] = useState(false)
  const [folderTouched, setFolderTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) {
      setUrl('')
      setParsed(null)
      setBranch('main')
      setFolder('')
      setDisplayName('')
      setSlug('')
      setProductId(null)
      setNameTouched(false)
      setSlugTouched(false)
      setBranchTouched(false)
      setFolderTouched(false)
      setError(null)
    }
  }, [opened])

  function onUrlChange(value: string) {
    setUrl(value)
    const p = parseGitUrl(value)
    setParsed(p)
    if (!p) return
    if (!nameTouched) setDisplayName(p.owner ? `${p.owner}/${p.repo}` : p.repo)
    if (!slugTouched) setSlug(p.slugSuggestion)
    if (!branchTouched) setBranch(p.branch ?? 'main')
    if (!folderTouched) setFolder(p.pathPrefix)
  }

  const canSubmit = !!parsed && !!slug.trim() && !!displayName.trim() && !!branch.trim()

  async function submit() {
    if (!parsed || !canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const created = await adminCreateGitSource({
        slug: slug.trim(),
        displayName: displayName.trim(),
        provider: parsed.provider,
        baseUrl: parsed.baseUrl ?? undefined,
        owner: parsed.owner || undefined,
        project: parsed.project || undefined,
        repo: parsed.repo,
        branch: branch.trim(),
        pathPrefix: folder.trim() || undefined,
        productId,
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
    <Modal opened={opened} onClose={onClose} title="New git source" centered size="lg">
      <Stack gap="md">
        <TextInput
          label="Git repo URL"
          placeholder="https://github.com/acme/docs  (or …/tree/main/docs)"
          description="Paste the repo URL. Provider, owner, repo — and branch + folder from a /tree/ link — are filled in automatically."
          value={url}
          onChange={(e) => onUrlChange(e.currentTarget.value)}
          error={url.trim() && !parsed ? 'Not a recognizable git repo URL' : undefined}
          data-autofocus
        />

        {parsed && (
          <Text fz="xs" c="dimmed">
            {`Detected: ${parsed.provider}${parsed.baseUrl ? ` (${parsed.baseUrl})` : ''} · ${
              parsed.owner ? `${parsed.owner}/` : ''
            }${parsed.repo}`}
          </Text>
        )}

        <Group grow>
          <TextInput
            label="Branch"
            placeholder="main"
            value={branch}
            onChange={(e) => {
              setBranchTouched(true)
              setBranch(e.currentTarget.value)
            }}
          />
          <TextInput
            label="Folder (optional)"
            placeholder="docs/billing"
            description="Limit the sync to a subfolder — e.g. for multi-product repos."
            value={folder}
            onChange={(e) => {
              setFolderTouched(true)
              setFolder(e.currentTarget.value)
            }}
          />
        </Group>

        <Select
          label="Product (optional)"
          placeholder="None"
          description="Synced docs are auto-tagged with this product, scoping search to the right users."
          data={(products ?? []).map((p) => ({ value: p.id, label: p.displayName }))}
          value={productId}
          onChange={setProductId}
          clearable
          searchable
        />

        <Group grow>
          <TextInput
            label="Display name"
            placeholder="acme/docs"
            value={displayName}
            onChange={(e) => {
              setNameTouched(true)
              setDisplayName(e.currentTarget.value)
            }}
          />
          <TextInput
            label="Slug"
            placeholder="repo-docs"
            description="Auto-filled from the repo; edit to customise. Must start with repo-."
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(e.currentTarget.value)
            }}
          />
        </Group>

        <Text fz="xs" c="dimmed">
          After creating, set the read token + adjust credential strategy / cadence in the drawer.
        </Text>

        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ----- Edit drawer -------------------------------------------------------

function GitSourceDrawer({
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
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

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

  async function withBusy(fn: () => Promise<void>, label: string) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(`${label} failed: ${explain(err)}`)
      reveal() // a delete that hid the drawer then failed must show the error
    } finally {
      setBusy(false)
    }
  }

  if (!row) {
    return (
      <Drawer opened={!hidden} onClose={onClose} title="Loading…" position="right" size="lg" padding="md">
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

const OAUTH_HINTS: Record<GitProvider, string> = {
  github:
    'GitHub: register an OAuth App / GitHub App (callback …/api/git-sources/oauth/callback) — URLs are standard, so just paste its client id + secret.',
  gitlab: 'GitLab: register an Application (scope "api"); URLs are standard for the host.',
  azure: 'Azure DevOps: a Microsoft Entra app; set its authorize/token URLs + scope 499b84ac-…/.default plus offline_access.'
}

/**
 * Standard OAuth endpoints per provider so the admin only pastes client
 * id/secret. github.com / gitlab.com (+ self-hosted via baseUrl) have fixed
 * URLs; Azure/Entra is tenant-specific so we can't default it.
 */
function defaultOAuthEndpoints(
  provider: GitProvider,
  baseUrl: string | null
): { authorizeUrl: string; tokenUrl: string; scopes: string[] } {
  if (provider === 'github') {
    const base = baseUrl ?? 'https://github.com'
    return {
      authorizeUrl: `${base}/login/oauth/authorize`,
      tokenUrl: `${base}/login/oauth/access_token`,
      scopes: ['repo']
    }
  }
  if (provider === 'gitlab') {
    const base = baseUrl ?? 'https://gitlab.com'
    return { authorizeUrl: `${base}/oauth/authorize`, tokenUrl: `${base}/oauth/token`, scopes: ['api'] }
  }
  return { authorizeUrl: '', tokenUrl: '', scopes: [] } // Entra: tenant-specific
}

function OAuthSection({
  row,
  busy,
  onSave,
  onClear
}: {
  row: AdminGitSourceRow
  busy: boolean
  onSave: (cfg: GitOAuthConfigRequest) => void
  onClear: () => void
}) {
  const defaults = defaultOAuthEndpoints(row.provider, row.baseUrl)
  const [clientId, setClientId] = useState(row.oauth?.clientId ?? '')
  const [authorizeUrl, setAuthorizeUrl] = useState(row.oauth?.authorizeUrl ?? defaults.authorizeUrl)
  const [tokenUrl, setTokenUrl] = useState(row.oauth?.tokenUrl ?? defaults.tokenUrl)
  const [scopes, setScopes] = useState((row.oauth?.scopes ?? defaults.scopes).join(' '))
  const [clientSecret, setClientSecret] = useState('')

  useEffect(() => {
    const d = defaultOAuthEndpoints(row.provider, row.baseUrl)
    setClientId(row.oauth?.clientId ?? '')
    setAuthorizeUrl(row.oauth?.authorizeUrl ?? d.authorizeUrl)
    setTokenUrl(row.oauth?.tokenUrl ?? d.tokenUrl)
    setScopes((row.oauth?.scopes ?? d.scopes).join(' '))
    setClientSecret('')
  }, [row])

  const canSave =
    !!clientId.trim() &&
    /^https:\/\//.test(authorizeUrl.trim()) &&
    /^https:\/\//.test(tokenUrl.trim())

  return (
    <Section title="OAuth (connect without a PAT)">
      <Stack gap="xs">
        <Text fz="xs" c="dimmed">
          Pre-register an OAuth app at the provider and paste its details so users can connect via
          OAuth instead of a PAT. The secret is sealed at rest. {OAUTH_HINTS[row.provider]}
        </Text>
        <TextInput
          size="xs"
          label="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.currentTarget.value)}
        />
        <Group grow>
          <TextInput
            size="xs"
            label="Authorize URL"
            placeholder="https://…/oauth/authorize"
            value={authorizeUrl}
            onChange={(e) => setAuthorizeUrl(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            label="Token URL"
            placeholder="https://…/oauth/token"
            value={tokenUrl}
            onChange={(e) => setTokenUrl(e.currentTarget.value)}
          />
        </Group>
        <TextInput
          size="xs"
          label="Scopes (space-separated)"
          placeholder="api"
          value={scopes}
          onChange={(e) => setScopes(e.currentTarget.value)}
        />
        <PasswordInput
          size="xs"
          label="Client secret"
          placeholder={
            row.clientSecretConfigured ? 'Secret set — paste to replace' : 'Client secret (if any)'
          }
          value={clientSecret}
          onChange={(e) => setClientSecret(e.currentTarget.value)}
        />
        <Group justify="flex-end" gap="xs">
          {row.oauth && (
            <Button size="xs" variant="subtle" color="red" onClick={onClear} disabled={busy}>
              Clear OAuth
            </Button>
          )}
          <Button
            size="xs"
            onClick={() =>
              onSave({
                clientId: clientId.trim(),
                authorizeUrl: authorizeUrl.trim(),
                tokenUrl: tokenUrl.trim(),
                scopes: scopes.split(/\s+/).filter(Boolean),
                ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {})
              })
            }
            loading={busy}
            disabled={!canSave}
          >
            {row.oauth ? 'Update OAuth' : 'Save OAuth'}
          </Button>
        </Group>
      </Stack>
    </Section>
  )
}

function DetailsSection({
  row,
  products,
  busy,
  onSave,
  onDelete
}: {
  row: AdminGitSourceRow
  products: ProductRef[] | null
  busy: boolean
  onSave: (patch: {
    displayName?: string
    branch?: string
    pathPrefix?: string
    folderRoot?: string
    productId?: string | null
    readStrategy?: GitCredStrategy
    writeStrategy?: GitCredStrategy
    syncInterval?: GitSyncInterval
    enabled?: boolean
  }) => void
  onDelete: () => void
}) {
  const [displayName, setDisplayName] = useState(row.displayName)
  const [branch, setBranch] = useState(row.branch)
  const [pathPrefix, setPathPrefix] = useState(row.pathPrefix)
  const [folderRoot, setFolderRoot] = useState(row.folderRoot)
  const [productId, setProductId] = useState<string | null>(row.productId)
  const [readStrategy, setReadStrategy] = useState<GitCredStrategy>(row.readStrategy)
  const [writeStrategy, setWriteStrategy] = useState<GitCredStrategy>(row.writeStrategy)
  const [syncInterval, setSyncInterval] = useState<GitSyncInterval>(row.syncInterval)
  const [enabled, setEnabled] = useState(row.enabled)

  useEffect(() => {
    setDisplayName(row.displayName)
    setBranch(row.branch)
    setPathPrefix(row.pathPrefix)
    setFolderRoot(row.folderRoot)
    setProductId(row.productId)
    setReadStrategy(row.readStrategy)
    setWriteStrategy(row.writeStrategy)
    setSyncInterval(row.syncInterval)
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
        <TextInput label="Repo" value={repoLabel(row)} disabled />
        <Group grow>
          <TextInput
            label="Branch"
            value={branch}
            onChange={(e) => setBranch(e.currentTarget.value)}
          />
          <TextInput
            label="Path prefix"
            value={pathPrefix}
            onChange={(e) => setPathPrefix(e.currentTarget.value)}
          />
        </Group>
        <TextInput
          label="Folder root"
          value={folderRoot}
          onChange={(e) => setFolderRoot(e.currentTarget.value)}
        />
        <Select
          label="Product"
          placeholder="None"
          description="Synced docs are auto-tagged with this product. Changing it re-tags + reindexes all docs from this source."
          data={(products ?? []).map((p) => ({ value: p.id, label: p.displayName }))}
          value={productId}
          onChange={setProductId}
          clearable
          searchable
        />
        <Group grow>
          <Select
            label="Read strategy"
            data={STRATEGY_OPTIONS}
            value={readStrategy}
            onChange={(v) => v && setReadStrategy(v as GitCredStrategy)}
            allowDeselect={false}
            description="Unattended cron sync needs the shared org token."
          />
          <Select
            label="Write strategy"
            data={STRATEGY_OPTIONS}
            value={writeStrategy}
            onChange={(v) => v && setWriteStrategy(v as GitCredStrategy)}
            allowDeselect={false}
            description="Write-back PR authorship (falls back to the org token)."
          />
        </Group>
        <Select
          label="Sync cadence"
          data={INTERVAL_OPTIONS}
          value={syncInterval}
          onChange={(v) => v && setSyncInterval(v as GitSyncInterval)}
          allowDeselect={false}
        />
        <Switch
          label="Enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" color="red" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
          <Button
            onClick={() =>
              onSave({
                displayName,
                branch,
                pathPrefix,
                folderRoot,
                productId,
                readStrategy,
                writeStrategy,
                syncInterval,
                enabled
              })
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

function SyncSection({
  row,
  busy,
  onSetToken,
  onClearToken,
  onSyncNow
}: {
  row: AdminGitSourceRow
  busy: boolean
  onSetToken: (token: string) => void
  onClearToken: () => void
  onSyncNow: () => void
}) {
  const [token, setToken] = useState('')
  const lastSynced = row.lastSyncedAt ? new Date(row.lastSyncedAt * 1000).toLocaleString() : 'never'

  return (
    <Section title="Read token & sync">
      <Stack gap="xs">
        <Text fz="xs" c="dimmed">
          Read strategy: <code>{row.readStrategy}</code>. The shared org token is used for
          unattended (cron) sync. Stored encrypted at rest.
          {row.sharedCredentialConfigured ? ' Paste a new value to rotate it.' : ''}
        </Text>
        <PasswordInput
          size="xs"
          placeholder={
            row.sharedCredentialConfigured
              ? 'Paste a new PAT to replace the stored one…'
              : 'Paste a personal access token (repo read scope)…'
          }
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
          disabled={busy}
        />
        <Group justify="space-between">
          <div>
            <Text fz="xs" c="dimmed">
              Last sync
            </Text>
            <Text fz="sm">
              {lastSynced}
              {row.lastSyncStatus ? ` · ${row.lastSyncStatus}` : ''}
            </Text>
            {row.lastSyncError && (
              <Text fz="xs" c="red">
                {row.lastSyncError}
              </Text>
            )}
          </div>
          <Group gap="xs">
            {row.sharedCredentialConfigured && (
              <Button size="xs" variant="subtle" color="red" onClick={onClearToken} disabled={busy}>
                Clear token
              </Button>
            )}
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                if (!token.trim()) return
                onSetToken(token.trim())
                setToken('')
              }}
              disabled={!token.trim() || busy}
            >
              {row.sharedCredentialConfigured ? 'Replace token' : 'Set token'}
            </Button>
            <Button size="xs" onClick={onSyncNow} disabled={busy}>
              Sync now
            </Button>
          </Group>
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
  row: AdminGitSourceRow
  teams: TeamRef[] | null
  products: ProductRef[] | null
  busy: boolean
  onSave: (rules: VisibilityRulePayload[]) => void
}) {
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
        Who can connect / write-back through this source. Synced docs are open-read like all docs;
        this gates the write surface. Empty = admins only.
      </Text>
      <Stack gap="sm">
        <Checkbox
          label="Everyone signed in"
          checked={everyone}
          onChange={(e) => setEveryone(e.currentTarget.checked)}
        />
        <SubSection title="Teams">
          {!teams && (
            <Text c="dimmed" fz="xs">
              Loading…
            </Text>
          )}
          {teams && teams.length === 0 && (
            <Text c="dimmed" fz="xs">
              No teams yet.
            </Text>
          )}
          {teams &&
            teams.map((t) => (
              <Checkbox
                key={t.id}
                label={t.displayName}
                checked={teamIds.has(t.id)}
                onChange={(e) => setTeamIds(toggleId(teamIds, t.id, e.currentTarget.checked))}
              />
            ))}
        </SubSection>
        <SubSection title="Products">
          {!products && (
            <Text c="dimmed" fz="xs">
              Loading…
            </Text>
          )}
          {products && products.length === 0 && (
            <Text c="dimmed" fz="xs">
              No products yet.
            </Text>
          )}
          {products &&
            products.map((p) => (
              <Checkbox
                key={p.id}
                label={p.displayName}
                checked={productIds.has(p.id)}
                onChange={(e) => setProductIds(toggleId(productIds, p.id, e.currentTarget.checked))}
              />
            ))}
        </SubSection>
        <Group justify="flex-end">
          <Button onClick={save} loading={busy} disabled={!dirty}>
            Save visibility
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
      <Stack gap={4}>{children}</Stack>
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
  return explainBase(err, {
    403: 'Admin permission required.',
    409: 'That slug is already taken.',
    400: (e) => {
      const body = e.body as { error?: string } | null
      return body?.error ? `Rejected: ${body.error}` : 'Server rejected the request.'
    }
  })
}
