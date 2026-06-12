import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Group, SimpleGrid, Stack, Text } from '@mantine/core'
import type { ProductRef, RoleRef, TeamRef, VisibilityRulePayload } from '@ctxlayer/shared'
import { Section, SubSection } from './admin-bits'
import { setsEqual, toggleId } from '../lib/set-utils'

/**
 * Shared "Visibility" rules editor used by both Admin · Upstreams and
 * Admin · Git repos drawers. Additive everyone/team/product (+ optional
 * role) rules; Save is enabled only when the selection is dirty vs the
 * server state. Omit `roles` (leave undefined) to hide the Roles column
 * (git sources have no role rules).
 */
export function VisibilityRulesEditor({
  rules,
  teams,
  products,
  roles,
  description,
  busy,
  onSave
}: {
  rules: VisibilityRulePayload[]
  teams: TeamRef[] | null
  products: ProductRef[] | null
  roles?: RoleRef[] | null
  description: string
  busy: boolean
  onSave: (rules: VisibilityRulePayload[]) => void
}) {
  // Memoise: every re-render of the parent rebuilds the visibility rules as a
  // fresh array reference (and the helper rebuilds fresh Set instances),
  // which made the reset-on-change effect below fire on every toggle
  // and snap the checkboxes back. Recompute only when the visibility
  // array itself changes (i.e. after reload following a save).
  const initial = useMemo(() => deriveInitialVisibility(rules), [rules])
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

  const withRoles = roles !== undefined

  const dirty =
    everyone !== initial.everyone ||
    !setsEqual(teamIds, initial.teamIds) ||
    !setsEqual(productIds, initial.productIds) ||
    (withRoles && !setsEqual(roleIds, initial.roleIds))

  const save = () => {
    const next: VisibilityRulePayload[] = []
    if (everyone) next.push({ scopeKind: 'everyone', scopeId: null })
    for (const id of teamIds) next.push({ scopeKind: 'team', scopeId: id })
    for (const id of productIds) next.push({ scopeKind: 'product', scopeId: id })
    if (withRoles) for (const id of roleIds) next.push({ scopeKind: 'role', scopeId: id })
    onSave(next)
  }

  return (
    <Section title="Visibility">
      <Text fz="xs" c="dimmed" mb={6}>
        {description}
      </Text>
      <Stack gap="sm">
        <Checkbox
          label="Everyone signed in"
          checked={everyone}
          onChange={(e) => setEveryone(e.currentTarget.checked)}
        />

        <ScopeGroup
          title="Teams"
          items={teams}
          emptyHint="No teams yet — create some on Admin · Teams."
          selected={teamIds}
          onToggle={(id, on) => setTeamIds(toggleId(teamIds, id, on))}
        />

        <ScopeGroup
          title="Products"
          items={products}
          emptyHint="No products yet — create some on Admin · Products."
          selected={productIds}
          onToggle={(id, on) => setProductIds(toggleId(productIds, id, on))}
        />

        {withRoles && (
          <ScopeGroup
            title="Roles"
            items={roles ?? null}
            emptyHint="No roles yet — create some on Admin · Roles."
            selected={roleIds}
            onToggle={(id, on) => setRoleIds(toggleId(roleIds, id, on))}
          />
        )}

        <Group justify="flex-end" gap="xs">
          <Button onClick={save} loading={busy} disabled={!dirty}>
            Save visibility
          </Button>
        </Group>
      </Stack>
    </Section>
  )
}

function ScopeGroup({
  title,
  items,
  emptyHint,
  selected,
  onToggle
}: {
  title: string
  items: { id: string; displayName: string }[] | null
  emptyHint: string
  selected: Set<string>
  onToggle: (id: string, on: boolean) => void
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
        <SimpleGrid cols={2} spacing={6} verticalSpacing={4}>
          {items.map((it) => (
            <Checkbox
              key={it.id}
              label={it.displayName}
              checked={selected.has(it.id)}
              onChange={(e) => onToggle(it.id, e.currentTarget.checked)}
            />
          ))}
        </SimpleGrid>
      )}
    </SubSection>
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
