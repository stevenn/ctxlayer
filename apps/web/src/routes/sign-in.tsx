import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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
    urlErrorCode != null
      ? ERROR_MESSAGE[urlErrorCode] ?? 'Sign-in failed.'
      : null

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
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24
      }}
    >
      <div style={{ maxWidth: 360, width: '100%' }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>ctxlayer</h1>
        <p style={{ color: 'var(--muted)', marginTop: 8 }}>The agent context layer.</p>
        {urlError ? (
          <div
            role="alert"
            style={{
              marginTop: 16,
              padding: '10px 12px',
              border: '1px solid color-mix(in srgb, crimson 50%, transparent)',
              borderRadius: 6,
              background: 'color-mix(in srgb, crimson 8%, transparent)',
              color: 'crimson',
              fontSize: 13
            }}
          >
            {urlError}
          </div>
        ) : null}
        <div style={{ display: 'grid', gap: 8, marginTop: 24 }}>
          {idps === null && !configError ? (
            <p style={{ color: 'var(--muted)' }}>Loading…</p>
          ) : null}
          {idps?.map((idp) => (
            <ProviderButton key={idp} idp={idp} />
          ))}
          {idps?.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              No identity providers are configured for this deployment. Ask an admin to set{' '}
              <code>ALLOWED_GOOGLE_HD</code> or <code>ALLOWED_GITHUB_ORG</code>.
            </p>
          ) : null}
          {configError ? <p style={{ color: 'crimson', fontSize: 13 }}>{configError}</p> : null}
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 24 }}>
          Only members of the configured Google domain or GitHub organisation can sign in.
        </p>
      </div>
    </div>
  )
}

function ProviderButton({ idp }: { idp: KnownIdp }) {
  const onClick = () => {
    location.assign(`/idp/${idp}/start`)
  }
  return (
    <button
      type="button"
      className={idp === 'google' ? 'primary' : undefined}
      onClick={onClick}
      style={{ width: '100%' }}
    >
      {PROVIDER_LABEL[idp]}
    </button>
  )
}
