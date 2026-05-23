export function SignIn() {
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
        <p style={{ color: 'var(--muted)', marginTop: 8 }}>
          The agent context layer.
        </p>
        <div style={{ display: 'grid', gap: 8, marginTop: 24 }}>
          <a className="primary" href="/idp/google/start?ui=1">
            <button className="primary" style={{ width: '100%' }}>
              Sign in with Google
            </button>
          </a>
          <a href="/idp/github/start?ui=1">
            <button style={{ width: '100%' }}>Sign in with GitHub</button>
          </a>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 24 }}>
          Only members of the configured Google domain or GitHub organisation can sign in.
        </p>
      </div>
    </div>
  )
}
