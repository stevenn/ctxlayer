import { Text } from '@mantine/core'
import { isStaticOAuthConfig } from '@ctxlayer/shared'
import type {
  AttachedDocRef,
  AttachedSkillRef,
  AuthStrategy,
  SupportedTransport,
  UpstreamAuthConfig,
  UpstreamToolSummary
} from '@ctxlayer/shared'
import type { ApiError } from '../../../lib/api'
import { explain as explainBase } from '../../../lib/explain'

export const TRANSPORT_OPTIONS: { value: SupportedTransport; label: string }[] = [
  { value: 'streamable_http', label: 'Streamable HTTP (current MCP spec)' },
  { value: 'sse', label: 'SSE (legacy)' }
]

/**
 * A UI-only strategy. The persisted `auth_strategy` is still `user_oauth` for
 * both DCR and pre-registered clients — the wire/worker tell them apart with
 * `isStaticOAuthConfig` (no new enum value, no migration). The form splits them
 * so a modern DCR setup doesn't render the static-client form it should leave
 * blank, and a non-DCR setup gets a dedicated form of its own.
 */
export type FormAuthStrategy = AuthStrategy | 'user_oauth_static'

export const OAUTH_STATIC: FormAuthStrategy = 'user_oauth_static'

/** Collapse the synthetic option back to the persisted `user_oauth`. */
export function persistedStrategy(s: FormAuthStrategy): AuthStrategy {
  return s === 'user_oauth_static' ? 'user_oauth' : s
}

/** Pick the form option for an existing row (static iff it carries a client). */
export function formStrategy(
  authStrategy: AuthStrategy,
  authConfig: UpstreamAuthConfig
): FormAuthStrategy {
  return authStrategy === 'user_oauth' && isStaticOAuthConfig(authConfig)
    ? 'user_oauth_static'
    : authStrategy
}

export const AUTH_OPTIONS: {
  value: FormAuthStrategy
  label: string
  description: string
  enabled: boolean
}[] = [
  {
    value: 'none',
    label: 'None',
    description: 'Upstream needs no credentials. Admin can refresh tools immediately.',
    enabled: true
  },
  {
    value: 'user_bearer',
    label: 'User bearer (personal token)',
    description: 'Each user pastes their own token on /upstreams.',
    enabled: true
  },
  {
    value: 'shared_bearer',
    label: 'Shared bearer',
    description: 'One token used for all users. Admin sets it here; users see no per-user setup.',
    enabled: true
  },
  {
    value: 'user_oauth',
    label: 'User OAuth — DCR (auto-register)',
    description:
      'Each user authorises at the upstream; ctxlayer auto-registers via dynamic client registration (RFC 7591) and refreshes transparently. For modern MCP servers that support DCR.',
    enabled: true
  },
  {
    value: 'user_oauth_static',
    label: 'User OAuth — pre-registered (non-DCR)',
    description:
      'For IdPs without DCR (e.g. Microsoft Entra fronting Azure DevOps): you register one app in the IdP and supply its client id/secret + endpoints. Each user still authorises individually.',
    enabled: true
  }
]

export type ToolsState =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      tools: UpstreamToolSummary[]
      attachedSkills: AttachedSkillRef[]
      attachedDocs: AttachedDocRef[]
    }
  | { kind: 'error'; message: string }

export function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    409: 'That slug is already taken.',
    502: (e) => bodyMessage(e) ?? 'Upstream is unreachable or returned an error.',
    400: (e) => bodyMessage(e) ?? 'Server rejected the request.'
  })
}

/**
 * Pull a human-readable message out of an ApiError body when the
 * backend supplied one. Conventions used by ctxlayer's REST: 4xx/5xx
 * bodies look like `{error: "code", hint?: "...", message?: "..."}`.
 * We prefer `hint` (instructive) → `message` (raw) → the `error` code
 * itself (machine-y but better than nothing).
 */
function bodyMessage(err: ApiError): string | null {
  const body = err.body as { error?: string; hint?: string; message?: string } | null | undefined
  if (!body || typeof body !== 'object') return null
  if (typeof body.hint === 'string' && body.hint) return body.hint
  if (typeof body.message === 'string' && body.message) return body.message
  if (typeof body.error === 'string' && body.error) return body.error
  return null
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          marginBottom: 6
        }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

export function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Text fz="xs" fw={500} mb={4}>
        {title}
      </Text>
      {children}
    </div>
  )
}
