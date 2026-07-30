/**
 * First-party remediation playbooks for GitHub organization 403s.
 *
 * The GitHub MCP upstream surfaces org access refusals as tool-RESULT
 * errors (`isError: true` content), so they bypass `sanitiseUpstreamError`
 * and would otherwise reach the agent as raw GitHub prose. For the refusals
 * an operator can actually act on — SAML SSO, IP allow list, and OAuth-app
 * access restriction — we detect the signature and REPLACE the upstream
 * content with a ctxlayer-authored, actionable fix. Replacing (not
 * appending) also closes the one path that forwarded upstream text
 * unsanitised for these cases.
 *
 * Each detector returns null when the message isn't its signature; the
 * umbrella `githubOrgAccessNudge` tries them in turn (most-specific first)
 * and leaves the normal error surface untouched when none match. The org,
 * when parsable from a github.com URL, is validated against GitHub's
 * org-slug charset before being interpolated into URLs we construct — the
 * raw message is never echoed back; only the extracted, constrained slug is.
 */

import { firstParty } from './provenance'

export interface GithubOrgNudge {
  /** First-party replacement text surfaced to the agent. */
  text: string
  /** Usage error_code so the Errors table separates it from generic 4xx. */
  errorCode: string
}

// GitHub org slugs: 1–39 chars, alphanumeric or hyphen, must start
// alphanumeric. Constrained enough to safely drop into a URL we build.
const GITHUB_ORG_RE = /github\.com\/(?:repos|orgs)\/([A-Za-z0-9][A-Za-z0-9-]{0,38})/i

function orgLabels(raw: string): { label: string; possessive: string; orgSlug: string } {
  const org = GITHUB_ORG_RE.exec(raw)?.[1] ?? null
  return {
    label: org ? `"${org}"` : 'the GitHub organization',
    possessive: org ? `${org}'s` : "the org's",
    orgSlug: org ?? '<your-org>'
  }
}

export function samlSsoNudge(raw: string, slug: string): string | null {
  if (!raw) return null
  // Conservative: only unambiguous SAML-SSO refusal phrasings.
  if (
    !/resource protected by organization saml|saml sso|saml enforcement|saml single sign-?on|grant your (?:oauth |personal access )?token access to this organization|single sign-?on/i.test(
      raw
    )
  ) {
    return null
  }
  const { label, possessive, orgSlug } = orgLabels(raw)
  return firstParty(
    `This GitHub call was blocked because org ${label} enforces SAML ` +
      `single sign-on and your GitHub authorization is not SSO-linked to it. Your token ` +
      `still works for your own repos — only ${possessive} resources are affected.\n\n` +
      `To fix (per-user, one-time):\n` +
      `1. Open https://github.com/orgs/${orgSlug}/sso and complete single sign-on to authorize ` +
      `your token for the org.\n` +
      `2. Re-run the tool. If it still fails, reconnect the ${slug} connector in ctxlayer ` +
      `at /app/upstreams (find GitHub → "Reconnect") so a fresh token is minted during the ` +
      `active SAML session.\n` +
      `3. If GitHub does not re-prompt on reconnect (an existing grant is cached), first ` +
      `revoke it at GitHub → Settings → Applications → Authorized OAuth Apps, then reconnect.`
  )
}

export function ipAllowListNudge(raw: string, _slug: string): string | null {
  if (!raw) return null
  if (!/ip allow ?list/i.test(raw)) return null
  const { label } = orgLabels(raw)
  return firstParty(
    `This GitHub call was blocked because org ${label} enforces an IP allow list and the ` +
      `request reached GitHub from an address that isn't on it. This is an organization-owner ` +
      `setting — your token can't override it.\n\n` +
      `To fix:\n` +
      `1. Ask a ${label} owner to update the org IP allow list (GitHub → org Settings → ` +
      `"Authentication security" → "IP allow list"): add the required egress range, or turn on ` +
      `"Enable IP allow list configuration for installed GitHub Apps" if access is via a GitHub App.\n` +
      `2. Re-run the tool once the list is updated. If the org can't relax it, this upstream can ` +
      `only reach organizations without an IP allow list.`
  )
}

export function oauthAppRestrictionNudge(raw: string, slug: string): string | null {
  if (!raw) return null
  if (!/oauth app access restrictions|restricting-access-to-your-organization/i.test(raw)) {
    return null
  }
  const { label, possessive } = orgLabels(raw)
  return firstParty(
    `This GitHub call was blocked because org ${label} restricts third-party OAuth apps and ` +
      `ctxlayer's GitHub app isn't approved for it. Your token still works for your own repos — ` +
      `only ${possessive} resources are gated.\n\n` +
      `To fix (one-time):\n` +
      `1. Reconnect the ${slug} connector in ctxlayer at /app/upstreams (find GitHub → ` +
      `"Reconnect"). Re-authorizing lets you request access to ${label} for the app during the ` +
      `OAuth grant.\n` +
      `2. An owner of ${label} then approves the request at GitHub → org Settings → ` +
      `"Third-party Access" → "OAuth app policy". Once approved, re-run the tool.`
  )
}

/**
 * Try each GitHub org-403 detector in turn and return the first match's
 * first-party text + a distinct usage error_code. Null when the message
 * is not a recognised org access refusal.
 */
export function githubOrgAccessNudge(raw: string, slug: string): GithubOrgNudge | null {
  const saml = samlSsoNudge(raw, slug)
  if (saml) return { text: saml, errorCode: 'saml_sso_required' }
  const ip = ipAllowListNudge(raw, slug)
  if (ip) return { text: ip, errorCode: 'org_ip_allow_list' }
  const oauth = oauthAppRestrictionNudge(raw, slug)
  if (oauth) return { text: oauth, errorCode: 'org_oauth_app_restricted' }
  return null
}
