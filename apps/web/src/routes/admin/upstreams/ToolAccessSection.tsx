import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Checkbox, Group, Radio, Stack, Text } from '@mantine/core'
import type { ProductRef, RoleRef, TeamRef, ToolAccessRule } from '@ctxlayer/shared'
import { fetchAdminUpstreamTools, fetchUpstreamToolAccess, putUpstreamToolAccess } from '../../../lib/api'
import { explain } from './helpers'
import { Section, SubSection } from './helpers'
import { ExpandChevron } from './ExpandChevron'

type NameMaps = { roles: Map<string, string>; teams: Map<string, string>; products: Map<string, string> }

interface Loaded {
  toolNames: string[]
  rulesByTool: Map<string, ToolAccessRule[]>
  orphans: { toolName: string; rules: ToolAccessRule[] }[]
}

/**
 * Per-tool ACL editor. Tools default to "Open (inherits upstream)"; the
 * moment a tool gets any rule it's locked to the listed principals and
 * hidden from everyone else (with a discoverability hint surfaced via
 * `list_my_context`). Orphaned rules — a rule whose tool is gone from the
 * catalogue — are flagged, never silently dropped.
 */
export function ToolAccessSection({
  upstreamId,
  teams,
  products,
  roles
}: {
  upstreamId: string
  teams: TeamRef[] | null
  products: ProductRef[] | null
  roles: RoleRef[] | null
}) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [toolsRes, accessRes] = await Promise.all([
          fetchAdminUpstreamTools(upstreamId, signal),
          fetchUpstreamToolAccess(upstreamId, signal)
        ])
        if (signal?.aborted) return
        const toolNames = toolsRes.tools.map((t) => t.toolName)
        const live = new Set(toolNames)
        const rulesByTool = new Map<string, ToolAccessRule[]>()
        const orphans: { toolName: string; rules: ToolAccessRule[] }[] = []
        for (const e of accessRes.entries) {
          rulesByTool.set(e.toolName, e.rules)
          if (!live.has(e.toolName)) orphans.push({ toolName: e.toolName, rules: e.rules })
        }
        setData({ toolNames, rulesByTool, orphans })
      } catch (err) {
        if (!signal?.aborted) setError(explain(err))
      }
    },
    [upstreamId]
  )

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  const maps = useMemo<NameMaps>(
    () => ({
      roles: new Map((roles ?? []).map((r) => [r.id, r.displayName])),
      teams: new Map((teams ?? []).map((t) => [t.id, t.displayName])),
      products: new Map((products ?? []).map((p) => [p.id, p.displayName]))
    }),
    [roles, teams, products]
  )

  return (
    <Section title="Tool access">
      <Text fz="xs" c="dimmed" mb={6}>
        Lock individual tools to specific roles / teams / products. Untouched tools stay open
        (inherit this upstream's visibility). A locked tool is hidden from everyone else.
      </Text>
      {error && (
        <Alert color="red" variant="light" radius="sm" mb="sm">
          {error}
        </Alert>
      )}
      {!data && !error && (
        <Text c="dimmed" fz="xs">
          Loading…
        </Text>
      )}
      {data && data.toolNames.length === 0 && data.orphans.length === 0 && (
        <Text c="dimmed" fz="xs">
          No cached tools yet — refresh the catalogue above first.
        </Text>
      )}
      {data && (data.toolNames.length > 0 || data.orphans.length > 0) && (
        <Stack gap={2}>
          {data.toolNames.map((name) => (
            <ToolAccessRow
              key={name}
              upstreamId={upstreamId}
              toolName={name}
              rules={data.rulesByTool.get(name) ?? []}
              orphaned={false}
              maps={maps}
              teams={teams}
              products={products}
              roles={roles}
              onSaved={() => load()}
            />
          ))}
          {data.orphans.map((o) => (
            <ToolAccessRow
              key={`orphan:${o.toolName}`}
              upstreamId={upstreamId}
              toolName={o.toolName}
              rules={o.rules}
              orphaned
              maps={maps}
              teams={teams}
              products={products}
              roles={roles}
              onSaved={() => load()}
            />
          ))}
        </Stack>
      )}
    </Section>
  )
}

function principalLabel(rule: ToolAccessRule, maps: NameMaps): string {
  if (rule.principalKind === 'everyone') return 'everyone'
  const id = rule.principalId ?? ''
  const m =
    rule.principalKind === 'role'
      ? maps.roles
      : rule.principalKind === 'team'
        ? maps.teams
        : maps.products
  return m.get(id) ?? id
}

function ToolAccessRow({
  upstreamId,
  toolName,
  rules,
  orphaned,
  maps,
  teams,
  products,
  roles,
  onSaved
}: {
  upstreamId: string
  toolName: string
  rules: ToolAccessRule[]
  orphaned: boolean
  maps: NameMaps
  teams: TeamRef[] | null
  products: ProductRef[] | null
  roles: RoleRef[] | null
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'open' | 'restrict'>(rules.length > 0 ? 'restrict' : 'open')
  const [everyone, setEveryone] = useState(rules.some((r) => r.principalKind === 'everyone'))
  const [roleIds, setRoleIds] = useState<Set<string>>(idSet(rules, 'role'))
  const [teamIds, setTeamIds] = useState<Set<string>>(idSet(rules, 'team'))
  const [productIds, setProductIds] = useState<Set<string>>(idSet(rules, 'product'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const locked = rules.length > 0
  const summary = locked ? rules.map((r) => principalLabel(r, maps)).join(', ') : 'Open (inherits upstream)'

  // A "restrict" with no principals selected can't be expressed (empty
  // rules == open), so block that save and tell the admin.
  const restrictEmpty =
    mode === 'restrict' && !everyone && roleIds.size === 0 && teamIds.size === 0 && productIds.size === 0

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const next: ToolAccessRule[] =
        mode === 'open'
          ? []
          : [
              ...(everyone ? [{ principalKind: 'everyone' as const, principalId: null }] : []),
              ...[...roleIds].map((id) => ({ principalKind: 'role' as const, principalId: id })),
              ...[...teamIds].map((id) => ({ principalKind: 'team' as const, principalId: id })),
              ...[...productIds].map((id) => ({ principalKind: 'product' as const, principalId: id }))
            ]
      await putUpstreamToolAccess(upstreamId, toolName, next)
      setOpen(false)
      onSaved()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
      <Group
        justify="space-between"
        wrap="nowrap"
        px="sm"
        py={6}
        style={{ cursor: 'pointer' }}
        onClick={() => setOpen((o) => !o)}
      >
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <ExpandChevron open={open} />
          <code style={{ fontSize: 12 }}>{toolName}</code>
          {orphaned && (
            <Badge color="orange" variant="light" size="xs">
              orphaned — not in catalogue
            </Badge>
          )}
        </Group>
        <Group gap={6} wrap="nowrap">
          {locked && (
            <Text fz={11} c="dimmed" style={{ fontVariantEmoji: 'text' }}>
              🔒
            </Text>
          )}
          <Text fz="xs" c={locked ? undefined : 'dimmed'} truncate="end" maw={220}>
            {summary}
          </Text>
        </Group>
      </Group>

      {open && (
        <Stack gap="xs" px="sm" pb="sm" pt={2}>
          {orphaned && (
            <Text fz="xs" c="orange">
              This rule targets a tool no longer in the catalogue (renamed or removed upstream).
              Clear it, or it stays inert until the tool returns.
            </Text>
          )}
          {error && (
            <Alert color="red" variant="light" radius="sm">
              {error}
            </Alert>
          )}
          <Radio.Group value={mode} onChange={(v) => setMode(v as 'open' | 'restrict')}>
            <Group gap="md">
              <Radio value="open" label="Open (inherit upstream)" />
              <Radio value="restrict" label="Restrict to…" />
            </Group>
          </Radio.Group>

          {mode === 'restrict' && (
            <Stack gap="sm" pl={4}>
              <Checkbox
                label="Everyone signed in (who can see this upstream)"
                checked={everyone}
                onChange={(e) => setEveryone(e.currentTarget.checked)}
              />
              <PrincipalGroup
                title="Roles"
                items={roles}
                selected={roleIds}
                onToggle={(id, on) => setRoleIds(toggleId(roleIds, id, on))}
                emptyHint="No roles — create some on Admin · Roles."
              />
              <PrincipalGroup
                title="Teams"
                items={teams}
                selected={teamIds}
                onToggle={(id, on) => setTeamIds(toggleId(teamIds, id, on))}
                emptyHint="No teams yet."
              />
              <PrincipalGroup
                title="Products"
                items={products}
                selected={productIds}
                onToggle={(id, on) => setProductIds(toggleId(productIds, id, on))}
                emptyHint="No products yet."
              />
              {restrictEmpty && (
                <Text fz="xs" c="orange">
                  Select at least one principal, or choose “Open”.
                </Text>
              )}
            </Stack>
          )}

          <Group justify="flex-end">
            <Button size="xs" onClick={save} loading={busy} disabled={restrictEmpty}>
              Save
            </Button>
          </Group>
        </Stack>
      )}
    </div>
  )
}

function PrincipalGroup({
  title,
  items,
  selected,
  onToggle,
  emptyHint
}: {
  title: string
  items: { id: string; displayName: string }[] | null
  selected: Set<string>
  onToggle: (id: string, on: boolean) => void
  emptyHint: string
}) {
  return (
    <SubSection title={title}>
      {!items && (
        <Text c="dimmed" fz="xs">
          Loading…
        </Text>
      )}
      {items && items.length === 0 && (
        <Text c="dimmed" fz="xs">
          {emptyHint}
        </Text>
      )}
      {items && items.length > 0 && (
        <Stack gap={4}>
          {items.map((it) => (
            <Checkbox
              key={it.id}
              label={it.displayName}
              checked={selected.has(it.id)}
              onChange={(e) => onToggle(it.id, e.currentTarget.checked)}
            />
          ))}
        </Stack>
      )}
    </SubSection>
  )
}

function idSet(rules: ToolAccessRule[], kind: 'role' | 'team' | 'product'): Set<string> {
  const s = new Set<string>()
  for (const r of rules) if (r.principalKind === kind && r.principalId) s.add(r.principalId)
  return s
}

function toggleId(current: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(current)
  if (on) next.add(id)
  else next.delete(id)
  return next
}
