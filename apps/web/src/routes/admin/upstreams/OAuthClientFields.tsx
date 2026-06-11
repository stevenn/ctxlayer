import { Button, Code, Group, PasswordInput, Stack, Text, Textarea, TextInput } from '@mantine/core'
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

// Microsoft Entra endpoints — replace {tenant} with the directory/tenant ID.
const ENTRA_AUTHORIZE = 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize'
const ENTRA_TOKEN = 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token'

// The two Azure DevOps shapes need DIFFERENT token audiences:
//   - Remote ADO MCP (https://mcp.dev.azure.com/{org}, no bridge) validates its
//     OWN resource (app id 2a72489c…). Request its named scopes: the gateway
//     `Ado.Mcp.Tools` + the read families. Provision the resource's service
//     principal once — `az ad sp create --id 2a72489c-aab2-4b65-b93a-a91edccf33b8`
//     — then named-scope dynamic consent works (avoid `.default`, which demands
//     the resource be pre-listed in the app and otherwise 650057s). Verified
//     2026-06-10. Add `…/work.write` etc. for write tools.
//   - Local @azure-devops/mcp behind a bridge reads a CLASSIC Azure DevOps REST
//     token (resource 499b84ac…), injected as ADO_MCP_AUTH_TOKEN.
// Scopes are stored/edited one-per-line (the Textarea below); `buildStaticOAuth`
// splits on any whitespace, so newline- and space-separated both round-trip.
const ADO_REMOTE_SCOPE = [
  'https://mcp.dev.azure.com/Ado.Mcp.Tools',
  'https://mcp.dev.azure.com/work.read',
  'https://mcp.dev.azure.com/wit.read',
  'https://mcp.dev.azure.com/repos.read',
  'https://mcp.dev.azure.com/wiki.read',
  'https://mcp.dev.azure.com/pipelines.read',
  'offline_access'
].join('\n')
const ADO_LOCAL_SCOPE = ['499b84ac-1321-427f-aa17-267ca6975798/.default', 'offline_access'].join('\n')

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
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text fz="xs" fw={600}>
          OAuth client (pre-registered)
        </Text>
        <Group gap={6} wrap="nowrap">
          <Button
            size="compact-xs"
            variant="default"
            onClick={() =>
              onChange({ authorizeUrl: ENTRA_AUTHORIZE, tokenUrl: ENTRA_TOKEN, scope: ADO_REMOTE_SCOPE })
            }
          >
            ADO remote MCP
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() =>
              onChange({ authorizeUrl: ENTRA_AUTHORIZE, tokenUrl: ENTRA_TOKEN, scope: ADO_LOCAL_SCOPE })
            }
          >
            ADO local server
          </Button>
        </Group>
      </Group>
      <Text fz="xs" c="dimmed">
        Register one app in the IdP, then paste its client id/secret + endpoints. Pick a preset,
        then replace <Code>{'{tenant}'}</Code> with your Entra tenant ID. <strong>ADO remote
        MCP</strong> (no bridge) targets the <Code>mcp.dev.azure.com</Code> resource — provision it
        once with <Code>az ad sp create --id 2a72489c-…</Code>, and add <Code>…/work.write</Code>{' '}
        etc. for write tools. <strong>ADO local server</strong> targets the classic Azure DevOps
        API audience, for a bridge running <Code>@azure-devops/mcp</Code>.
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
