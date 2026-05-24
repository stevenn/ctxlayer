import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Button, Stack, Text, Title } from '@mantine/core'
import { fetchConfig } from '../lib/api'
import type { KnownIdp } from '@ctxlayer/shared'

const PROVIDER_LABEL: Record<KnownIdp, string> = {
  google: 'Sign in with Google',
  github: 'Sign in with GitHub'
}

const ERROR_MESSAGE: Record<string, string> = {
  google_disabled: 'Google sign-in is not configured for this deployment.',
  github_disabled: 'GitHub sign-in is not configured for this deployment.',
  wrong_domain: 'Your Google account is outside the allowed domain for this org.',
  not_in_org: 'Your GitHub account is not a member of the allowed organisation.',
  state_mismatch: 'Your sign-in session expired. Please try again.',
  token_exchange_failed: 'Could not complete sign-in with the identity provider. Try again.',
  profile_fetch_failed: 'Could not read your profile from the identity provider.',
  idp_error: 'The identity provider returned an error during sign-in.'
}

export function SignIn() {
  const [params] = useSearchParams()
  const [idps, setIdps] = useState<KnownIdp[] | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  const urlErrorCode = params.get('error')
  const urlError =
    urlErrorCode != null ? ERROR_MESSAGE[urlErrorCode] ?? 'Sign-in failed.' : null

  useEffect(() => {
    const ctrl = new AbortController()
    fetchConfig(ctrl.signal).then(
      (cfg) => {
        if (!ctrl.signal.aborted) setIdps(cfg.idps)
      },
      (err) => {
        if (ctrl.signal.aborted) return
        setConfigError('Could not load sign-in options.')
        console.error(err)
      }
    )
    return () => ctrl.abort()
  }, [])

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Stack gap="lg">
          <div>
            <Title order={2} fz={22} fw={700} mb={4}>
              ctxlayer
            </Title>
            <Text c="dimmed" fz="sm">
              The agent context layer for your org.
            </Text>
          </div>

          {urlError && (
            <Alert color="red" variant="light" radius="sm">
              {urlError}
            </Alert>
          )}

          <Stack gap="xs">
            {idps === null && !configError && <Text c="dimmed">Loading…</Text>}
            {idps?.map((idp) => (
              <ProviderButton key={idp} idp={idp} />
            ))}
            {idps?.length === 0 && (
              <Text c="dimmed" fz="sm">
                No identity providers are configured for this deployment. Ask an admin to
                set <code>ALLOWED_GOOGLE_HD</code> or <code>ALLOWED_GITHUB_ORG</code>.
              </Text>
            )}
            {configError && (
              <Text c="red" fz="sm">
                {configError}
              </Text>
            )}
          </Stack>

          <Text c="dimmed" fz="xs">
            Only members of the configured Google domain or GitHub organisation can sign in.
          </Text>
        </Stack>
      </div>
    </div>
  )
}

function ProviderButton({ idp }: { idp: KnownIdp }) {
  return (
    <Button
      fullWidth
      variant={idp === 'google' ? 'filled' : 'default'}
      onClick={() => location.assign(`/idp/${idp}/start`)}
    >
      {PROVIDER_LABEL[idp]}
    </Button>
  )
}
