import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Button, Group, Stack, Text, TextInput, Title } from '@mantine/core'
import { fetchConfig } from '../lib/api'
import type { KnownIdp } from '@ctxlayer/shared'
import { useLoad } from '../lib/use-load'
import { BrandMark } from '../components/brand-mark'

const PROVIDER_LABEL: Record<KnownIdp, string> = {
  google: 'Sign in with Google',
  github: 'Sign in with GitHub'
}

// Red error reasons. `pending_approval` is handled separately as a friendly,
// non-error state.
const ERROR_MESSAGE: Record<string, string> = {
  google_disabled: 'Google sign-in is not configured for this deployment.',
  github_disabled: 'GitHub sign-in is not configured for this deployment.',
  wrong_domain: 'Your Google account is outside the allowed domain for this org.',
  not_in_org: 'Your GitHub account is not a member of the allowed organisation.',
  state_mismatch: 'Your sign-in session expired. Please try again.',
  token_exchange_failed: 'Could not complete sign-in with the identity provider. Try again.',
  profile_fetch_failed: 'Could not read your profile from the identity provider.',
  idp_error: 'The identity provider returned an error during sign-in.',
  invite_required:
    'This workspace is invite-only. Enter a join code below, or ask an admin to invite you.',
  invalid_join_code: "That join code isn't valid. Double-check it and try again.",
  code_expired: 'That join code has expired. Ask an admin for a new one.',
  access_denied: "Your account isn't allowed to access this workspace.",
  suspended: 'Your access has been suspended. Contact an admin to restore it.'
}

// Reasons that mean "you need a join code" — show the code field when one
// of these comes back so the user can retry inline.
const CODE_REASONS = new Set(['invite_required', 'invalid_join_code', 'code_expired'])

export function SignIn() {
  const [params] = useSearchParams()
  const { data: config, error: configError } = useLoad(
    async (signal) => {
      try {
        return await fetchConfig(signal)
      } catch (err) {
        if (!signal?.aborted) console.error(err)
        throw err
      }
    },
    [],
    { explain: () => 'Could not load sign-in options.' }
  )
  const idps = config?.idps ?? null
  const policy = config?.accessPolicy ?? 'open_domain'
  const [code, setCode] = useState(params.get('join') ?? '')

  const urlErrorCode = params.get('error')
  const pending = urlErrorCode === 'pending_approval'
  const urlError =
    urlErrorCode && !pending ? (ERROR_MESSAGE[urlErrorCode] ?? 'Sign-in failed.') : null

  // Show the join-code input under the invite policy, when a deep-link code
  // is present, or when an error tells us a code is needed.
  const showCode = useMemo(
    () =>
      policy === 'invite' ||
      !!params.get('join') ||
      (urlErrorCode != null && CODE_REASONS.has(urlErrorCode)),
    [policy, params, urlErrorCode]
  )

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Stack gap="lg">
          <div>
            <Group gap={8} mb={4} align="center">
              <BrandMark size={26} />
              <Title order={2} fz={22} fw={700}>
                ctxlayer
              </Title>
            </Group>
            <Text c="dimmed" fz="sm">
              The agent context layer for your org.
            </Text>
          </div>

          {pending && (
            <Alert color="blue" variant="light" radius="sm" title="Access pending approval">
              Thanks for signing in — an admin needs to approve your access. You'll be able to sign
              in once they do.
            </Alert>
          )}
          {urlError && (
            <Alert color="red" variant="light" radius="sm">
              {urlError}
            </Alert>
          )}

          {showCode && (
            <TextInput
              label="Join code"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              autoComplete="off"
            />
          )}

          <Stack gap="xs">
            {idps === null && !configError && <Text c="dimmed">Loading…</Text>}
            {idps?.map((idp) => (
              <ProviderButton key={idp} idp={idp} code={showCode ? code : ''} />
            ))}
            {idps?.length === 0 && (
              <Text c="dimmed" fz="sm">
                No identity providers are configured for this deployment. Ask an admin to set up
                Google or GitHub sign-in.
              </Text>
            )}
            {configError && (
              <Text c="red" fz="sm">
                {configError}
              </Text>
            )}
          </Stack>

          <Text c="dimmed" fz="xs">
            {policy === 'invite'
              ? 'This workspace is invite-only. You need an invite or a join code to sign in.'
              : policy === 'request'
                ? 'Sign in to request access — an admin will review and approve you.'
                : 'Only members of the configured org can sign in.'}
          </Text>
        </Stack>
      </div>
    </div>
  )
}

function ProviderButton({ idp, code }: { idp: KnownIdp; code: string }) {
  const href =
    code.trim().length > 0
      ? `/idp/${idp}/start?join=${encodeURIComponent(code.trim())}`
      : `/idp/${idp}/start`
  return (
    <Button
      fullWidth
      variant={idp === 'google' ? 'filled' : 'default'}
      onClick={() => location.assign(href)}
    >
      {PROVIDER_LABEL[idp]}
    </Button>
  )
}
