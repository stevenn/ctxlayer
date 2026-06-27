import { useEffect, useState } from 'react'
import { Button, Group, Select, Stack, Switch, TextInput } from '@mantine/core'
import type { AdminGitSourceRow, GitCredStrategy, GitSyncInterval, ProductRef } from '@ctxlayer/shared'
import { INTERVAL_OPTIONS, repoLabel, Section, STRATEGY_OPTIONS } from './helpers'

export function DetailsSection({
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

  // Re-sync form state from the server row only when one of the fields
  // this section actually mirrors changes (i.e. after this section's own
  // save round-trips). Depending on `row` identity instead would wipe
  // in-progress edits every time a SIBLING section saves — the drawer's
  // reload() produces a fresh row object even when these fields are
  // untouched.
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
  }, [
    row.id,
    row.displayName,
    row.branch,
    row.pathPrefix,
    row.folderRoot,
    row.productId,
    row.readStrategy,
    row.writeStrategy,
    row.syncInterval,
    row.enabled
  ])

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
            placeholder="auto-detect"
            description="Blank = repo default (e.g. main / master). Case-sensitive."
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
