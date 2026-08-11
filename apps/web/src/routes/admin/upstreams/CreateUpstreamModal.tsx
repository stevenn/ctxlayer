import { useState } from 'react'
import { Select, TextInput } from '@mantine/core'
import type { SupportedTransport } from '@ctxlayer/shared'
import { FormModalShell } from '../../../components/form-modal-shell'
import { adminCreateUpstream } from '../../../lib/api'
import { useBusyAction } from '../../../lib/use-busy'
import { useSlugSuggest } from '../../../lib/use-slug-suggest'
import {
  AUTH_OPTIONS,
  OAUTH_STATIC,
  TRANSPORT_OPTIONS,
  explain,
  persistedStrategy,
  type FormAuthStrategy
} from './helpers'
import {
  EMPTY_OAUTH_FIELDS,
  OAuthClientFields,
  buildStaticOAuth,
  type OAuthClientFieldValues
} from './OAuthClientFields'

// Conditionally mounted by the caller (`{createOpen && …}`), so all state
// resets for free on close — no `opened` prop / reset effect.
export function CreateUpstreamModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const slugField = useSlugSuggest('upstream', displayName)
  const [transport, setTransport] = useState<SupportedTransport>('streamable_http')
  const [url, setUrl] = useState('')
  const [authStrategy, setAuthStrategy] = useState<FormAuthStrategy>('user_bearer')
  const [oauthFields, setOauthFields] = useState<OAuthClientFieldValues>(EMPTY_OAUTH_FIELDS)
  const { busy, error, run: withBusy } = useBusyAction({ explain })

  const submit = () =>
    withBusy(async () => {
      const oauth = authStrategy === OAUTH_STATIC ? buildStaticOAuth(oauthFields) : undefined
      const created = await adminCreateUpstream({
        slug: slugField.slug.trim(),
        displayName: displayName.trim(),
        transport,
        url: url.trim(),
        authStrategy: persistedStrategy(authStrategy),
        authConfig: oauth ? { oauth } : undefined,
        enabled: true
      })
      onCreated(created.id)
    }, 'Create')

  return (
    <FormModalShell
      title="New upstream"
      size="lg"
      error={error}
      busy={busy}
      submitLabel="Create"
      submitDisabled={!slugField.slug.trim() || !displayName.trim() || !url.trim()}
      onSubmit={submit}
      onClose={onClose}
    >
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
        onChange={(v) => v && setAuthStrategy(v as FormAuthStrategy)}
        allowDeselect={false}
        description={AUTH_OPTIONS.find((o) => o.value === authStrategy)?.description}
      />
      {authStrategy === OAUTH_STATIC && (
        <OAuthClientFields
          values={oauthFields}
          onChange={(patch) => setOauthFields((v) => ({ ...v, ...patch }))}
        />
      )}
    </FormModalShell>
  )
}
