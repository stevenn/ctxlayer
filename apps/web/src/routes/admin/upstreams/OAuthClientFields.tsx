import { Button, Code, Group, PasswordInput, Stack, Text, TextInput } from '@mantine/core'
import type { UpstreamAuthConfig } from '@ctxlayer/shared'

// Static (pre-registered) OAuth client editor, shared by the create modal and
// the details drawer. For IdPs that don't support dynamic client registration
// (e.g. Microsoft Entra ID fronting Azure DevOps): the operator registers one
// app in the IdP and supplies its client id/secret + endpoints here. Blank =
// the default DCR path.

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

/** Hydrate the editable fields from a (redacted) stored oauth config. */
export function oauthFieldsFromConfig(
  oauth: UpstreamAuthConfig['oauth']
): OAuthClientFieldValues {
  return {
    clientId: oauth?.clientId ?? '',
    authorizeUrl: oauth?.authorizeUrl ?? '',
    tokenUrl: oauth?.tokenUrl ?? '',
    scope: (oauth?.scopes ?? []).join(' '),
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
      <Group justify="space-between" wrap="nowrap">
        <Text fz="xs" fw={600}>
          OAuth client (pre-registered)
        </Text>
        <Button
          size="compact-xs"
          variant="default"
          onClick={() =>
            onChange({
              authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
              tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
              scope: '499b84ac-1321-427f-aa17-267ca6975798/.default offline_access'
            })
          }
        >
          Entra / ADO preset
        </Button>
      </Group>
      <Text fz="xs" c="dimmed">
        Blank = the default dynamic client registration (DCR). Fill these for an IdP that doesn't
        support DCR (e.g. Microsoft Entra ID fronting Azure DevOps): register one app in the IdP,
        then paste its client id/secret + endpoints. After the preset, replace{' '}
        <Code>{'{tenant}'}</Code> with your Entra tenant ID.
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
      <TextInput
        label="Scopes (space-separated)"
        value={values.scope}
        onChange={(e) => onChange({ scope: e.currentTarget.value })}
      />
    </Stack>
  )
}
