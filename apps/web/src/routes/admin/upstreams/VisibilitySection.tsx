import type {
  AdminUpstreamRow,
  ProductRef,
  RoleRef,
  TeamRef,
  VisibilityRulePayload
} from '@ctxlayer/shared'
import { VisibilityRulesEditor } from '../../../components/visibility-editor'

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
  return (
    <VisibilityRulesEditor
      rules={row.visibility}
      teams={teams}
      products={products}
      roles={roles}
      description="Additive rules — a user sees this upstream if any rule grants access. Empty rule set = invisible to everyone."
      busy={busy}
      onSave={onSave}
    />
  )
}
