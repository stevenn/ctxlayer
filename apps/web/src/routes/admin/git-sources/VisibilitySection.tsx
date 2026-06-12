import type {
  AdminGitSourceRow,
  ProductRef,
  TeamRef,
  VisibilityRulePayload
} from '@ctxlayer/shared'
import { VisibilityRulesEditor } from '../../../components/visibility-editor'

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
  return (
    <VisibilityRulesEditor
      rules={row.visibility}
      teams={teams}
      products={products}
      description="Who can connect / write-back through this source. Synced docs are open-read like all docs; this gates the write surface. Empty = admins only."
      busy={busy}
      onSave={onSave}
    />
  )
}
