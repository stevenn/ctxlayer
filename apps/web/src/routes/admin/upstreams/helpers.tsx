import { Text } from '@mantine/core'
import type {
  AttachedDocRef,
  AttachedSkillRef,
  AuthStrategy,
  SupportedTransport,
  UpstreamToolSummary
} from '@ctxlayer/shared'
import type { ApiError } from '../../../lib/api'
import { explain as explainBase } from '../../../lib/explain'

export const TRANSPORT_OPTIONS: { value: SupportedTransport; label: string }[] = [
  { value: 'streamable_http', label: 'Streamable HTTP (current MCP spec)' },
  { value: 'sse', label: 'SSE (legacy)' }
]

export const AUTH_OPTIONS: {
  value: AuthStrategy
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
    label: 'User OAuth (DCR + PKCE)',
    description:
      'Each user authorises at the upstream. ctxlayer dynamically registers itself and transparently refreshes.',
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
