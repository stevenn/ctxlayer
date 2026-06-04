import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Group, Stack, Text } from '@mantine/core'
import type {
  AdminUpstreamRow,
  ProductRef,
  RoleRef,
  TeamRef,
  VisibilityRulePayload
} from '@ctxlayer/shared'
import { Section, SubSection } from './helpers'

export function VisibilitySection({
  row,
  teams,
  products,
  roles,
  busy,
  onSave
}: {
  row: AdminUpstreamRow
  teams: TeamRef[] | null
  products: ProductRef[] | null
  roles: RoleRef[] | null
  busy: boolean
  onSave: (rules: VisibilityRulePayload[]) => void
}) {
  // Memoise: every re-render of the parent rebuilds `row.visibility` as a
  // fresh array reference (and the helper rebuilds fresh Set instances),
  // which made the reset-on-row-change effect below fire on every toggle
  // and snap the checkboxes back. Recompute only when the visibility
  // array itself changes (i.e. after reload following a save).
  const initial = useMemo(() => deriveInitialVisibility(row.visibility), [row.visibility])
  const [everyone, setEveryone] = useState(initial.everyone)
  const [teamIds, setTeamIds] = useState(initial.teamIds)
  const [productIds, setProductIds] = useState(initial.productIds)
  const [roleIds, setRoleIds] = useState(initial.roleIds)

  useEffect(() => {
    setEveryone(initial.everyone)
    setTeamIds(initial.teamIds)
    setProductIds(initial.productIds)
    setRoleIds(initial.roleIds)
  }, [initial])

  const dirty =
    everyone !== initial.everyone ||
    !setsEqual(teamIds, initial.teamIds) ||
    !setsEqual(productIds, initial.productIds) ||
    !setsEqual(roleIds, initial.roleIds)

  const save = () => {
    const rules: VisibilityRulePayload[] = []
    if (everyone) rules.push({ scopeKind: 'everyone', scopeId: null })
    for (const id of teamIds) rules.push({ scopeKind: 'team', scopeId: id })
    for (const id of productIds) rules.push({ scopeKind: 'product', scopeId: id })
    for (const id of roleIds) rules.push({ scopeKind: 'role', scopeId: id })
    onSave(rules)
  }

  return (
    <Section title="Visibility">
      <Text fz="xs" c="dimmed" mb={6}>
        Additive rules — a user sees this upstream if any rule grants access. Empty rule set =
        invisible to everyone.
      </Text>
      <Stack gap="sm">
        <Checkbox
          label="Everyone signed in"
          checked={everyone}
          onChange={(e) => setEveryone(e.currentTarget.checked)}
        />

        <SubSection title="Teams">
          {!teams && (
            <Text c="dimmed" fz="xs">
              Loading…
            </Text>
          )}
          {teams && teams.length === 0 && (
            <Text c="dimmed" fz="xs">
              No teams yet — create some on Admin · Teams.
            </Text>
          )}
          {teams && teams.length > 0 && (
            <Stack gap={4}>
              {teams.map((t) => (
                <Checkbox
                  key={t.id}
                  label={t.displayName}
                  checked={teamIds.has(t.id)}
                  onChange={(e) => setTeamIds(toggleId(teamIds, t.id, e.currentTarget.checked))}
                />
              ))}
            </Stack>
          )}
        </SubSection>

        <SubSection title="Products">
          {!products && (
            <Text c="dimmed" fz="xs">
              Loading…
            </Text>
          )}
          {products && products.length === 0 && (
            <Text c="dimmed" fz="xs">
              No products yet — create some on Admin · Products.
            </Text>
          )}
          {products && products.length > 0 && (
            <Stack gap={4}>
              {products.map((p) => (
                <Checkbox
                  key={p.id}
                  label={p.displayName}
                  checked={productIds.has(p.id)}
                  onChange={(e) =>
                    setProductIds(toggleId(productIds, p.id, e.currentTarget.checked))
                  }
                />
              ))}
            </Stack>
          )}
        </SubSection>

        <SubSection title="Roles">
          {!roles && (
            <Text c="dimmed" fz="xs">
              Loading…
            </Text>
          )}
          {roles && roles.length === 0 && (
            <Text c="dimmed" fz="xs">
              No roles yet — create some on Admin · Roles.
            </Text>
          )}
          {roles && roles.length > 0 && (
            <Stack gap={4}>
              {roles.map((r) => (
                <Checkbox
                  key={r.id}
                  label={r.displayName}
                  checked={roleIds.has(r.id)}
                  onChange={(e) => setRoleIds(toggleId(roleIds, r.id, e.currentTarget.checked))}
                />
              ))}
            </Stack>
          )}
        </SubSection>

        <Group justify="flex-end" gap="xs">
          <Button onClick={save} loading={busy} disabled={!dirty}>
            Save visibility
          </Button>
        </Group>
      </Stack>
    </Section>
  )
}

function deriveInitialVisibility(rules: VisibilityRulePayload[]): {
  everyone: boolean
  teamIds: Set<string>
  productIds: Set<string>
  roleIds: Set<string>
} {
  const teamIds = new Set<string>()
  const productIds = new Set<string>()
  const roleIds = new Set<string>()
  let everyone = false
  for (const r of rules) {
    if (r.scopeKind === 'everyone') everyone = true
    else if (r.scopeKind === 'team' && r.scopeId) teamIds.add(r.scopeId)
    else if (r.scopeKind === 'product' && r.scopeId) productIds.add(r.scopeId)
    else if (r.scopeKind === 'role' && r.scopeId) roleIds.add(r.scopeId)
  }
  return { everyone, teamIds, productIds, roleIds }
}

function toggleId(current: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(current)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}
