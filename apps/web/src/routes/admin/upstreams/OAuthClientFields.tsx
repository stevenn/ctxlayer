import { PasswordInput, Stack, Text, Textarea, TextInput } from '@mantine/core'
import type { UpstreamAuthConfig } from '@ctxlayer/shared'

// Static (pre-registered) OAuth client editor, shared by the create modal and
// the details drawer. For IdPs that don't support dynamic client registration
// (RFC 7591): the operator registers one app in the IdP and supplies its client
// id/secret + authorize/token endpoints + scopes here. Kept deliberately
// provider-agnostic — provider-specific recipes (e.g. Azure DevOps via Entra,
// incl. the exact endpoints/scopes and service-principal setup) live in
// docs/plan/B-stdio-bridge.md, not in this form.

export interface OAuthClientFieldValues {
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  scope: string
  /** Write-only — the server seals it and never returns it. */
  secret: string
}

export const EMPTY_OAUTH_FIELDS: OAuthClientFieldValues = {
  clientId: '',
  authorizeUrl: '',
  tokenUrl: '',
  scope: '',
  secret: ''
}

// Scopes are stored/edited one-per-line (the Textarea below); `buildStaticOAuth`
// splits on any whitespace, so newline- and space-separated both round-trip.

/** Hydrate the editable fields from a (redacted) stored oauth config. */
export function oauthFieldsFromConfig(
  oauth: UpstreamAuthConfig['oauth']
): OAuthClientFieldValues {
  return {
    clientId: oauth?.clientId ?? '',
    authorizeUrl: oauth?.authorizeUrl ?? '',
    tokenUrl: oauth?.tokenUrl ?? '',
    scope: (oauth?.scopes ?? []).join('\n'),
    secret: ''
  }
}

/**
 * Build the oauth sub-config to send, or `undefined` when the admin supplied
 * no static field (leave the upstream on the DCR path / untouched). The
 * `secret` rides only when newly typed — the server preserves the sealed one
 * otherwise.
 */
export function buildStaticOAuth(values: OAuthClientFieldValues): UpstreamAuthConfig['oauth'] {
  const clientId = values.clientId.trim()
  const authorizeUrl = values.authorizeUrl.trim()
  const tokenUrl = values.tokenUrl.trim()
  if (!clientId && !authorizeUrl && !tokenUrl) return undefined
  const scopes = values.scope.split(/\s+/).filter(Boolean)
  const secret = values.secret.trim()
  return {
    clientId: clientId || undefined,
    authorizeUrl: authorizeUrl || undefined,
    tokenUrl: tokenUrl || undefined,
    scopes: scopes.length ? scopes : undefined,
    clientSecret: secret || undefined
  }
}

export function OAuthClientFields({
  values,
  onChange,
  secretConfigured = false
}: {
  values: OAuthClientFieldValues
  onChange: (patch: Partial<OAuthClientFieldValues>) => void
  secretConfigured?: boolean
}) {
  return (
    <Stack
      gap={6}
      p="sm"
      style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}
    >
      <Text fz="xs" fw={600}>
        OAuth client (pre-registered)
      </Text>
      <Text fz="xs" c="dimmed">
        For an OAuth IdP that doesn&apos;t support dynamic client registration: register an app in
        the IdP, then paste its client id, secret, authorize/token endpoints, and scopes. Leave the
        secret blank for a public client. Provider-specific recipes (endpoints, scopes, any
        provider setup) are in the upstream docs.
      </Text>
      <TextInput
        label="Client ID"
        value={values.clientId}
        onChange={(e) => onChange({ clientId: e.currentTarget.value })}
      />
      <PasswordInput
        label="Client secret"
        placeholder={secretConfigured ? '•••••• set — blank keeps it' : 'optional (public client)'}
        value={values.secret}
        onChange={(e) => onChange({ secret: e.currentTarget.value })}
      />
      <TextInput
        label="Authorize URL"
        value={values.authorizeUrl}
        onChange={(e) => onChange({ authorizeUrl: e.currentTarget.value })}
      />
      <TextInput
        label="Token URL"
        value={values.tokenUrl}
        onChange={(e) => onChange({ tokenUrl: e.currentTarget.value })}
      />
      <Textarea
        label="Scopes"
        description="One per line (or space-separated)."
        autosize
        minRows={3}
        maxRows={8}
        value={values.scope}
        onChange={(e) => onChange({ scope: e.currentTarget.value })}
      />
    </Stack>
  )
}
