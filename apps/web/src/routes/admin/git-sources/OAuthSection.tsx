import { useEffect, useState } from 'react'
import { Button, Group, PasswordInput, Stack, Text, TextInput } from '@mantine/core'
import type { AdminGitSourceRow, GitOAuthConfigRequest, GitProvider } from '@ctxlayer/shared'
import { Section } from './helpers'

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

export function OAuthSection({
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

  // Re-sync form state from the server row only when the OAuth config
  // itself changes (own save / Clear OAuth round-trips — incl. clearing
  // the write-only secret field). Depending on `row` identity would wipe
  // in-progress edits whenever a SIBLING section saves, because the
  // drawer's reload() produces a fresh row object every time.
  useEffect(() => {
    const d = defaultOAuthEndpoints(row.provider, row.baseUrl)
    setClientId(row.oauth?.clientId ?? '')
    setAuthorizeUrl(row.oauth?.authorizeUrl ?? d.authorizeUrl)
    setTokenUrl(row.oauth?.tokenUrl ?? d.tokenUrl)
    setScopes((row.oauth?.scopes ?? d.scopes).join(' '))
    setClientSecret('')
  }, [
    row.id,
    row.provider,
    row.baseUrl,
    row.oauth?.clientId,
    row.oauth?.authorizeUrl,
    row.oauth?.tokenUrl,
    (row.oauth?.scopes ?? []).join(' '),
    row.clientSecretConfigured
  ])

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
