import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Group, Stack, Text } from '@mantine/core'
import type {
  AdminGitSourceRow,
  ProductRef,
  TeamRef,
  VisibilityRulePayload
} from '@ctxlayer/shared'
import { Section, SubSection } from './helpers'

export function VisibilitySection({
  row,
  teams,
  products,
  busy,
  onSave
}: {
  row: AdminGitSourceRow
  teams: TeamRef[] | null
  products: ProductRef[] | null
  busy: boolean
  onSave: (rules: VisibilityRulePayload[]) => void
}) {
  const initial = useMemo(() => deriveInitialVisibility(row.visibility), [row.visibility])
  const [everyone, setEveryone] = useState(initial.everyone)
  const [teamIds, setTeamIds] = useState(initial.teamIds)
  const [productIds, setProductIds] = useState(initial.productIds)

  useEffect(() => {
    setEveryone(initial.everyone)
    setTeamIds(initial.teamIds)
    setProductIds(initial.productIds)
  }, [initial])

  const dirty =
    everyone !== initial.everyone ||
    !setsEqual(teamIds, initial.teamIds) ||
    !setsEqual(productIds, initial.productIds)

  const save = () => {
    const rules: VisibilityRulePayload[] = []
    if (everyone) rules.push({ scopeKind: 'everyone', scopeId: null })
    for (const id of teamIds) rules.push({ scopeKind: 'team', scopeId: id })
    for (const id of productIds) rules.push({ scopeKind: 'product', scopeId: id })
    onSave(rules)
  }

  return (
    <Section title="Visibility">
      <Text fz="xs" c="dimmed" mb={6}>
        Who can connect / write-back through this source. Synced docs are open-read like all docs;
        this gates the write surface. Empty = admins only.
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
              No teams yet.
            </Text>
          )}
          {teams &&
            teams.map((t) => (
              <Checkbox
                key={t.id}
                label={t.displayName}
                checked={teamIds.has(t.id)}
                onChange={(e) => setTeamIds(toggleId(teamIds, t.id, e.currentTarget.checked))}
              />
            ))}
        </SubSection>
        <SubSection title="Products">
          {!products && (
            <Text c="dimmed" fz="xs">
              Loading…
            </Text>
          )}
          {products && products.length === 0 && (
            <Text c="dimmed" fz="xs">
              No products yet.
            </Text>
          )}
          {products &&
            products.map((p) => (
              <Checkbox
                key={p.id}
                label={p.displayName}
                checked={productIds.has(p.id)}
                onChange={(e) => setProductIds(toggleId(productIds, p.id, e.currentTarget.checked))}
              />
            ))}
        </SubSection>
        <Group justify="flex-end">
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
} {
  const teamIds = new Set<string>()
  const productIds = new Set<string>()
  let everyone = false
  for (const r of rules) {
    if (r.scopeKind === 'everyone') everyone = true
    else if (r.scopeKind === 'team' && r.scopeId) teamIds.add(r.scopeId)
    else if (r.scopeKind === 'product' && r.scopeId) productIds.add(r.scopeId)
  }
  return { everyone, teamIds, productIds }
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
