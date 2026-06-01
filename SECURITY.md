# Security Policy

ctxlayer is identity- and credential-handling infrastructure: it runs an OAuth
provider, brokers per-user upstream credentials (sealed at rest with AES-GCM),
and proxies third-party MCP servers. We take security reports seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately to **stevenn@satisa.be**. If you prefer, use GitHub's
["Report a vulnerability"](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
private advisory flow on this repository.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof-of-concept if you have one).
- The affected component (Worker endpoint, MCP tool, OAuth/IdP flow, SPA, CLI)
  and commit/deploy if known.

We aim to acknowledge a report within a few business days and to keep you
updated as we investigate and fix. Please give us a reasonable window to
remediate before any public disclosure, and avoid privacy violations, data
destruction, or service degradation while researching.

## Scope

This is a self-hosted project: each operator runs their own instance. Reports
are most useful when they concern the **code in this repository** — for
example:

- Authentication / authorization bypass (session, OAuth provider, IdP
  allowlist, admin gating, CSRF).
- Credential exposure (decrypted upstream creds, token leakage in logs).
- SSRF / trust-boundary gaps in the upstream proxy or git-source fetchers.
- Injection of untrusted upstream content into model-visible context.

Misconfiguration of a *particular deployment* (e.g. a forgotten allowlist) is
the operator's responsibility, but if our docs or defaults make such a mistake
easy, we'd still like to hear it.

## Supported versions

ctxlayer is pre-1.0. Security fixes land on `main`; there is no back-porting to
older commits. Run a recent `main` for the latest fixes.
