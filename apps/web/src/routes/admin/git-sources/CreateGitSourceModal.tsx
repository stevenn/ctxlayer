import { useState } from 'react'
import { Alert, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core'
import type { ProductRef } from '@ctxlayer/shared'
import { adminCreateGitSource } from '../../../lib/api'
import { parseGitUrl, type ParsedGitUrl } from '../../../lib/git-url'
import { explain } from './helpers'

// Conditionally mounted by the caller (`{createOpen && …}`), so all state
// resets for free on close — no `opened` prop / reset effect.
export function CreateGitSourceModal({
  products,
  onClose,
  onCreated
}: {
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
    <Modal opened onClose={onClose} title="New git source" centered size="lg">
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
