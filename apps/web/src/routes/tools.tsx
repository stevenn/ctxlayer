import { type CSSProperties, useState } from 'react'
import {
  Alert,
  Badge,
  Card,
  CopyButton,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton
} from '@mantine/core'
import { Link } from 'react-router-dom'
import type {
  ToolsDirectoryBuiltin,
  ToolsDirectoryTool,
  ToolsDirectoryUpstream,
  UpstreamToolSummary
} from '@ctxlayer/shared'
import { fetchTools, fetchUserUpstreamTools } from '../lib/api'
import { explain } from '../lib/explain'
import { useLoad } from '../lib/use-load'

// Per-upstream detail payload (input schema + per-tool attachments), lazily
// fetched from GET /api/upstreams/:id/tools on the first details-expand and
// shared across every tool row in that upstream's card.
type DetailsState =
  | undefined
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; byName: Map<string, UpstreamToolSummary> }

export function Tools() {
  const [error, setError] = useState<string | null>(null)
  const { data } = useLoad(fetchTools, [], { explain, onError: setError })
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()

  const builtins = data?.builtins.filter((b) => matchBuiltin(b, query)) ?? []

  return (
    <Stack gap="md">
      <div>
        <Title order={2} fz={20} fw={600}>
          Tools
        </Title>
        <Text c="dimmed" fz="sm">
          Every tool available to your agent — ctxlayer&apos;s built-ins plus the tools of each
          upstream you can see, grouped by family. Manage connections on the{' '}
          <Link to="/app/upstreams">Upstreams</Link> page.
        </Text>
      </div>

      <TextInput
        placeholder="Search tools by name or description…"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        size="sm"
      />

      {error && (
        <Alert color="red" variant="light" radius="sm">
          {error}
        </Alert>
      )}
      {!data && !error && <Text c="dimmed">Loading…</Text>}

      {data && (builtins.length > 0 || !query) && (
        <Card withBorder radius="sm" padding="md">
          <Stack gap="xs">
            <div>
              <Text fw={600} fz="md">
                Built-in tools
              </Text>
              <Text fz="xs" c="dimmed">
                ctxlayer&apos;s own tools — always available, no connection needed.
              </Text>
            </div>
            <div>
              {builtins.map((b, i) => (
                <BuiltinRow key={b.name} tool={b} shaded={i % 2 === 1} />
              ))}
            </div>
          </Stack>
        </Card>
      )}

      {data?.upstreams.map((u) => (
        <UpstreamToolsCard key={u.slug} upstream={u} query={query} />
      ))}
    </Stack>
  )
}

function UpstreamToolsCard({
  upstream,
  query
}: {
  upstream: ToolsDirectoryUpstream
  query: string
}) {
  // Filter tools by the search query; drop empty groups. With no query we
  // show everything (including empty-cache upstreams as a "connect" hint).
  const groups = upstream.groups
    .map((g) => ({ family: g.family, tools: g.tools.filter((t) => matchTool(t, query)) }))
    .filter((g) => g.tools.length > 0)

  // Per-tool detail (input schema + per-tool attachments) is lazy-loaded once
  // per card the first time any row's "details" is opened, then reused.
  const [details, setDetails] = useState<DetailsState>(undefined)
  async function ensureDetails() {
    if (details) return
    setDetails({ kind: 'loading' })
    try {
      const res = await fetchUserUpstreamTools(upstream.id)
      setDetails({ kind: 'ready', byName: new Map(res.tools.map((t) => [t.toolName, t])) })
    } catch (err) {
      setDetails({ kind: 'error', message: explain(err) })
    }
  }

  if (query && groups.length === 0) return null

  return (
    <Card withBorder radius="sm" padding="md">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Text fw={600} fz="md">
              {upstream.displayName}
            </Text>
            <Text fz="xs" c="dimmed">
              <code>{upstream.slug}</code> ·{' '}
              {`${upstream.toolsCount} tool${upstream.toolsCount === 1 ? '' : 's'}`}
            </Text>
          </Group>
          <ConnectionBadge upstream={upstream} />
        </Group>

        {upstream.attached_skills.length + upstream.attached_docs.length > 0 && (
          <Group gap={6}>
            {upstream.attached_skills.map((s) => (
              <Badge key={`s-${s.slug}`} color="violet" variant="light" size="sm" title={`Skill: ${s.title}`}>
                🧠 {s.title}
              </Badge>
            ))}
            {upstream.attached_docs.map((d) => (
              <Badge key={`d-${d.slug}`} color="blue" variant="light" size="sm" title={`Doc: ${d.title}`}>
                📄 {d.title}
              </Badge>
            ))}
          </Group>
        )}

        {groups.length === 0 ? (
          <Text fz="xs" c="dimmed">
            No tools cached yet — connect on the <Link to="/app/upstreams">Upstreams</Link> page to
            populate the catalogue.
          </Text>
        ) : (
          groups.map((g) => (
            <div key={g.family || '_general'}>
              <Group
                justify="space-between"
                align="center"
                mt={8}
                mb={2}
                style={{ borderBottom: '1px solid var(--border)', paddingBottom: 3 }}
              >
                <Text fz="xs" fw={700} tt="uppercase" style={{ letterSpacing: '0.07em', color: 'var(--text-dim)' }}>
                  {g.family || 'General'}
                </Text>
                <Text fz={10} c="dimmed">
                  {g.tools.length}
                </Text>
              </Group>
              <div>
                {g.tools.map((t, i) => (
                  <ToolRow
                    key={t.name}
                    tool={t}
                    details={details}
                    onExpand={ensureDetails}
                    shaded={i % 2 === 1}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </Stack>
    </Card>
  )
}

// Shared zebra band for every tool list row (built-in + upstream) so the two
// lists read as one table. Subtle, theme-adaptive tint (same color-mix
// technique as index.css); contiguous rows (no gap) make the bands continuous.
function bandStyle(shaded: boolean): CSSProperties {
  return {
    backgroundColor: shaded ? 'color-mix(in srgb, var(--text-muted) 8%, transparent)' : 'transparent',
    padding: '5px 8px'
  }
}

function ToolRow({
  tool,
  details,
  onExpand,
  shaded
}: {
  tool: ToolsDirectoryTool
  details: DetailsState
  onExpand: () => void
  shaded: boolean
}) {
  const [open, setOpen] = useState(false)
  function toggle() {
    setOpen((o) => {
      const next = !o
      if (next) void onExpand()
      return next
    })
  }
  const summary = details?.kind === 'ready' ? details.byName.get(tool.name) : undefined

  return (
    <div style={bandStyle(shaded)}>
      <Group gap="xs" wrap="nowrap" align="center">
        <code style={{ fontSize: 12 }}>{tool.name}</code>
        <CopyButton value={tool.call}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied!' : `Copy ${tool.call}`} withArrow>
              <UnstyledButton
                onClick={copy}
                aria-label={`Copy agent-callable name ${tool.call}`}
                style={{ cursor: 'pointer' }}
              >
                <code style={{ fontSize: 11, opacity: 0.6 }}>{tool.call}</code>
              </UnstyledButton>
            </Tooltip>
          )}
        </CopyButton>
        {tool.restricted && (
          <Tooltip label={`Restricted — requires ${requiresSummary(tool)}`} multiline w={260} withArrow>
            <Badge color="orange" variant="light" size="xs">
              restricted
            </Badge>
          </Tooltip>
        )}
        <UnstyledButton
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? `Hide schema for ${tool.name}` : `Show schema for ${tool.name}`}
        >
          <Group gap={3} wrap="nowrap" align="center">
            <Caret open={open} />
            <Text fz="xs" fw={600} style={{ color: 'var(--accent)' }}>
              schema
            </Text>
          </Group>
        </UnstyledButton>
      </Group>
      {tool.summary && (
        <Text fz="xs" c="dimmed">
          {tool.summary}
        </Text>
      )}
      {open && <ToolDetails details={details} summary={summary} />}
    </div>
  )
}

// Colored disclosure caret for the "schema" toggle. Points right when closed,
// rotates to a downward "v" when open. SVG keeps it crisp at any zoom (same
// idea as the admin ExpandChevron, but tinted with the accent color).
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={11}
      height={11}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 120ms ease',
        color: 'var(--accent)'
      }}
      aria-hidden="true"
    >
      <path
        d="M6 3.5 L10.5 8 L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ToolDetails({
  details,
  summary
}: {
  details: DetailsState
  summary: UpstreamToolSummary | undefined
}) {
  if (!details || details.kind === 'loading') {
    return (
      <Text fz="xs" c="dimmed" mt={4}>
        Loading details…
      </Text>
    )
  }
  if (details.kind === 'error') {
    return (
      <Text fz="xs" c="red" mt={4}>
        {details.message}
      </Text>
    )
  }
  if (!summary) {
    return (
      <Text fz="xs" c="dimmed" mt={4}>
        No details available.
      </Text>
    )
  }
  return (
    <Stack gap={6} mt={6} pl="sm">
      {summary.attachedSkills.length + summary.attachedDocs.length > 0 && (
        <Group gap={6}>
          {summary.attachedSkills.map((s) => (
            <Badge key={`s-${s.slug}`} color="violet" variant="light" size="xs" title={`Skill: ${s.title}`}>
              🧠 {s.title}
            </Badge>
          ))}
          {summary.attachedDocs.map((d) => (
            <Badge key={`d-${d.slug}`} color="blue" variant="light" size="xs" title={`Doc: ${d.title}`}>
              📄 {d.title}
            </Badge>
          ))}
        </Group>
      )}
      <SchemaParamsBox schema={summary.inputSchema} />
    </Stack>
  )
}

// The INPUT SCHEMA code-box: a JSON-schema object's top-level params rendered
// as a nested, monospace, code-like block. Shared by the upstream tool detail
// view and the built-in rows so both schemas read identically.
function SchemaParamsBox({ schema }: { schema: unknown }) {
  const params = schemaParams(schema)
  if (params.length === 0) {
    return (
      <Text fz="xs" c="dimmed">
        No input parameters.
      </Text>
    )
  }
  return (
    <Stack
      gap={6}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '10px 12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
      }}
    >
      <Text fz={10} fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
        Input schema
      </Text>
      {params.map((p) => (
        <div key={p.name}>
          <Group gap={6} wrap="nowrap" align="baseline">
            <code style={{ fontSize: 12, color: 'var(--accent)' }}>{p.name}</code>
            <Text span c="dimmed" fz={11}>
              {p.type}
              {p.required ? ' · required' : ''}
            </Text>
          </Group>
          {p.description && (
            <Text c="dimmed" fz={11} mt={1}>
              {p.description}
            </Text>
          )}
        </div>
      ))}
    </Stack>
  )
}

// A built-in tool row: native name + description + a "schema" disclosure that
// reveals its input schema (carried in the feed, so no fetch). Mirrors the
// upstream ToolRow's zebra band + accent caret so the two lists read as one
// table. Built-ins with no arguments show "No input parameters."
function BuiltinRow({ tool, shaded }: { tool: ToolsDirectoryBuiltin; shaded: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={bandStyle(shaded)}>
      <Group gap="xs" wrap="nowrap" align="center">
        <code style={{ fontSize: 12 }}>{tool.name}</code>
        <UnstyledButton
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? `Hide schema for ${tool.name}` : `Show schema for ${tool.name}`}
        >
          <Group gap={3} wrap="nowrap" align="center">
            <Caret open={open} />
            <Text fz="xs" fw={600} style={{ color: 'var(--accent)' }}>
              schema
            </Text>
          </Group>
        </UnstyledButton>
      </Group>
      <Text fz="xs" c="dimmed">
        {tool.description}
      </Text>
      {open && (
        <Stack gap={6} mt={6} pl="sm">
          <SchemaParamsBox schema={tool.inputSchema} />
        </Stack>
      )}
    </div>
  )
}

interface SchemaParam {
  name: string
  type: string
  required: boolean
  description?: string
}

// Flatten a JSON-schema object's top-level properties into a readable
// parameter list. Best-effort: unknown shapes degrade to type 'any'.
function schemaParams(schema: unknown): SchemaParam[] {
  if (!schema || typeof schema !== 'object') return []
  const s = schema as { properties?: Record<string, unknown>; required?: unknown }
  if (!s.properties || typeof s.properties !== 'object') return []
  const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
  return Object.entries(s.properties).map(([name, raw]) => {
    const p = (raw ?? {}) as { type?: unknown; description?: unknown; enum?: unknown; anyOf?: unknown }
    let type = 'any'
    if (typeof p.type === 'string') type = p.type
    else if (Array.isArray(p.enum)) type = 'enum'
    else if (Array.isArray(p.anyOf)) type = 'union'
    return {
      name,
      type,
      required: req.has(name),
      description: typeof p.description === 'string' ? p.description : undefined
    }
  })
}

function ConnectionBadge({ upstream }: { upstream: ToolsDirectoryUpstream }) {
  if (upstream.needsReauth) {
    return (
      <Badge
        color="orange"
        variant="light"
        component={Link}
        to="/app/upstreams"
        style={{ cursor: 'pointer' }}
      >
        reconnect →
      </Badge>
    )
  }
  if (upstream.connected) {
    return <Badge color="green">connected</Badge>
  }
  return (
    <Badge color="gray" variant="light" component={Link} to="/app/upstreams" style={{ cursor: 'pointer' }}>
      connect →
    </Badge>
  )
}

function matchBuiltin(b: ToolsDirectoryBuiltin, query: string): boolean {
  if (!query) return true
  return (
    b.name.toLowerCase().includes(query) ||
    b.title.toLowerCase().includes(query) ||
    b.description.toLowerCase().includes(query)
  )
}

function matchTool(t: ToolsDirectoryTool, query: string): boolean {
  if (!query) return true
  return t.name.toLowerCase().includes(query) || t.summary.toLowerCase().includes(query)
}

function requiresSummary(t: ToolsDirectoryTool): string {
  const r = t.requires
  if (!r) return 'additional access'
  const parts = [
    ...r.roles.map((n) => `${n} (role)`),
    ...r.teams.map((n) => `${n} (team)`),
    ...r.products.map((n) => `${n} (product)`)
  ]
  return parts.length > 0 ? parts.join(', ') : 'additional access'
}
