import { useEffect, useState } from 'react'
import { fetchConfig } from '../lib/api'
import type { KnownIdp } from '@ctxlayer/shared'

const PROVIDER_LABEL: Record<KnownIdp, string> = {
  google: 'Sign in with Google',
  github: 'Sign in with GitHub'
}

export function SignIn() {
  const [idps, setIdps] = useState<KnownIdp[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    fetchConfig(ctrl.signal).then(
      (cfg) => {
        if (!ctrl.signal.aborted) setIdps(cfg.idps)
      },
      (err) => {
        if (ctrl.signal.aborted) return
        setError('Could not load sign-in options.')
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
        <div style={{ display: 'grid', gap: 8, marginTop: 24 }}>
          {idps === null && !error ? <p style={{ color: 'var(--muted)' }}>Loading…</p> : null}
          {idps?.map((idp) => (
            <ProviderButton key={idp} idp={idp} />
          ))}
          {idps?.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              No identity providers are configured for this deployment. Ask an admin to set{' '}
              <code>ALLOWED_GOOGLE_HD</code> or <code>ALLOWED_GITHUB_ORG</code>.
            </p>
          ) : null}
          {error ? <p style={{ color: 'crimson', fontSize: 13 }}>{error}</p> : null}
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
    location.assign(`/idp/${idp}/start?ui=1`)
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
