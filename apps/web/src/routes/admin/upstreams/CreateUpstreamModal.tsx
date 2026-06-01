import { useEffect, useState } from 'react'
import { Alert, Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core'
import type { AuthStrategy, SupportedTransport } from '@ctxlayer/shared'
import { adminCreateUpstream } from '../../../lib/api'
import { useSlugSuggest } from '../../../lib/use-slug-suggest'
import { AUTH_OPTIONS, TRANSPORT_OPTIONS, explain } from './helpers'

export function CreateUpstreamModal({
  opened,
  onClose,
  onCreated
}: {
  opened: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const slugField = useSlugSuggest('upstream', displayName)
  const [transport, setTransport] = useState<SupportedTransport>('streamable_http')
  const [url, setUrl] = useState('')
  const [authStrategy, setAuthStrategy] = useState<AuthStrategy>('user_bearer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) {
      setDisplayName('')
      slugField.reset()
      setTransport('streamable_http')
      setUrl('')
      setAuthStrategy('user_bearer')
      setError(null)
    }
  }, [opened])

  async function submit() {
    if (!slugField.slug.trim() || !displayName.trim() || !url.trim()) return
    setBusy(true)
    setError(null)
    try {
      const created = await adminCreateUpstream({
        slug: slugField.slug.trim(),
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
          placeholder="up-notion"
          description="Used in tool namespacing — agents see up-notion__search_pages. Must start with up-, then lowercase/digits/dashes, max 24. Immutable after creation."
          value={slugField.slug}
          onChange={(e) => slugField.setSlug(e.currentTarget.value)}
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
            disabled={!slugField.slug.trim() || !displayName.trim() || !url.trim()}
          >
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
