import { describe, expect, it } from 'vitest'
import { CTX_MARK_CLOSE, CTX_MARK_OPEN } from './provenance'
import {
  githubOrgAccessNudge,
  ipAllowListNudge,
  oauthAppRestrictionNudge,
  samlSsoNudge
} from './github-nudges'

const SAML =
  'failed to resolve git reference: failed to get repository info: GET ' +
  'https://api.github.com/repos/The-Yuki-Company/yuki-public-api-specs: 403 ' +
  'Resource protected by organization SAML enforcement. You must grant your OAuth ' +
  'token access to this organization.'

const IP_ALLOW_LIST =
  'failed to get repository info: GET https://api.github.com/repos/payroll-no/timeterminal: ' +
  '403 Although you appear to have the correct authorization credentials, the `payroll-no` ' +
  'organization has an IP allow list enabled, and 203.0.113.5 is not permitted to access ' +
  'this resource.'

const OAUTH_RESTRICTED =
  'GET https://api.github.com/repos/acme-co/widgets: 403 Although you appear to have the ' +
  'correct authorization credentials, the `acme-co` organization has enabled OAuth App ' +
  'access restrictions, meaning that data access to third-parties is limited. For more ' +
  'information on these restrictions, including how to enable this app, visit ' +
  'https://docs.github.com/articles/restricting-access-to-your-organization-s-data/'

describe('samlSsoNudge', () => {
  it('returns a first-party playbook for a SAML-SSO refusal, marked as ctxlayer-authored', () => {
    const out = samlSsoNudge(SAML, 'up-github')
    expect(out).not.toBeNull()
    expect(out).toContain(CTX_MARK_OPEN)
    expect(out).toContain(CTX_MARK_CLOSE)
    expect(out).toContain('SAML')
  })

  it('extracts the org and builds the SSO URL from it', () => {
    const out = samlSsoNudge(SAML, 'up-github')!
    expect(out).toContain('"The-Yuki-Company"')
    expect(out).toContain('https://github.com/orgs/The-Yuki-Company/sso')
  })

  it('names the connector slug + the exact reconnect route', () => {
    const out = samlSsoNudge(SAML, 'up-github')!
    expect(out).toContain('up-github')
    expect(out).toContain('/app/upstreams')
    expect(out).toContain('Reconnect')
  })

  it('does not echo the raw upstream text verbatim (no leaked repo path)', () => {
    const out = samlSsoNudge(SAML, 'up-github')!
    expect(out).not.toContain('yuki-public-api-specs')
    expect(out).not.toContain('api.github.com/repos')
  })

  it('falls back to a placeholder org when none is parsable', () => {
    const out = samlSsoNudge('403 Resource protected by organization SAML enforcement.', 'up-github')!
    expect(out).toContain('https://github.com/orgs/<your-org>/sso')
  })

  it('returns null for an unrelated error (no false rewrite)', () => {
    expect(samlSsoNudge('HTTP 404 Not Found', 'up-github')).toBeNull()
    expect(samlSsoNudge('', 'up-github')).toBeNull()
    // Neither sibling 403 masquerades as SAML.
    expect(samlSsoNudge(IP_ALLOW_LIST, 'up-github')).toBeNull()
    expect(samlSsoNudge(OAUTH_RESTRICTED, 'up-github')).toBeNull()
  })
})

describe('ipAllowListNudge', () => {
  it('returns a first-party, actionable playbook naming the org', () => {
    const out = ipAllowListNudge(IP_ALLOW_LIST, 'up-github')
    expect(out).not.toBeNull()
    expect(out).toContain(CTX_MARK_OPEN)
    expect(out).toContain('"payroll-no"')
    expect(out).toContain('IP allow list')
  })

  it('does not echo the offending IP or the raw repo path', () => {
    const out = ipAllowListNudge(IP_ALLOW_LIST, 'up-github')!
    expect(out).not.toContain('203.0.113.5')
    expect(out).not.toContain('api.github.com/repos')
  })

  it('returns null for unrelated errors and the other 403 signatures', () => {
    expect(ipAllowListNudge('HTTP 404 Not Found', 'up-github')).toBeNull()
    expect(ipAllowListNudge(SAML, 'up-github')).toBeNull()
    expect(ipAllowListNudge(OAUTH_RESTRICTED, 'up-github')).toBeNull()
    expect(ipAllowListNudge('', 'up-github')).toBeNull()
  })
})

describe('oauthAppRestrictionNudge', () => {
  it('returns a first-party playbook pointing at the reconnect + approval flow', () => {
    const out = oauthAppRestrictionNudge(OAUTH_RESTRICTED, 'up-github')
    expect(out).not.toBeNull()
    expect(out).toContain(CTX_MARK_OPEN)
    expect(out).toContain('"acme-co"')
    expect(out).toContain('/app/upstreams')
    expect(out).toContain('Reconnect')
  })

  it('matches the docs-URL phrasing variant too', () => {
    const variant =
      '403 the `acme-co` organization limits access — see ' +
      'https://docs.github.com/articles/restricting-access-to-your-organization-s-data/'
    expect(oauthAppRestrictionNudge(variant, 'up-github')).not.toBeNull()
  })

  it('returns null for unrelated errors and the other 403 signatures', () => {
    expect(oauthAppRestrictionNudge('HTTP 404 Not Found', 'up-github')).toBeNull()
    expect(oauthAppRestrictionNudge(SAML, 'up-github')).toBeNull()
    expect(oauthAppRestrictionNudge(IP_ALLOW_LIST, 'up-github')).toBeNull()
    expect(oauthAppRestrictionNudge('', 'up-github')).toBeNull()
  })
})

describe('githubOrgAccessNudge (umbrella)', () => {
  it('routes each signature to its distinct usage error_code', () => {
    expect(githubOrgAccessNudge(SAML, 'up-github')?.errorCode).toBe('saml_sso_required')
    expect(githubOrgAccessNudge(IP_ALLOW_LIST, 'up-github')?.errorCode).toBe('org_ip_allow_list')
    expect(githubOrgAccessNudge(OAUTH_RESTRICTED, 'up-github')?.errorCode).toBe(
      'org_oauth_app_restricted'
    )
  })

  it('carries the matching first-party text', () => {
    const out = githubOrgAccessNudge(IP_ALLOW_LIST, 'up-github')!
    expect(out.text).toContain(CTX_MARK_OPEN)
    expect(out.text).toContain('IP allow list')
  })

  it('returns null when no org-403 signature matches', () => {
    expect(githubOrgAccessNudge('HTTP 500 internal error', 'up-github')).toBeNull()
    expect(githubOrgAccessNudge('', 'up-github')).toBeNull()
  })
})
