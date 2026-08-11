import { useEffect, useState } from 'react'
import { Button, Text, TextInput } from '@mantine/core'
import { FormModalShell } from '../../components/form-modal-shell'
import { ListPageShell } from '../../components/list-page-shell'
import { type ProductRef, suggestSlug } from '@ctxlayer/shared'
import {
  adminCreateProduct,
  adminDeleteProduct,
  adminPatchProduct,
  fetchProducts
} from '../../lib/api'
import { clickableRow } from '../../lib/a11y'
import { explain as explainBase } from '../../lib/explain'
import { useBusyAction } from '../../lib/use-busy'
import { useLoad } from '../../lib/use-load'
import { useDialogs } from '../../lib/dialogs'

export function AdminProducts() {
  const { data: products, error, reload } = useLoad(fetchProducts, [], { explain })
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<ProductRef | null>(null)

  return (
    <>
      <ListPageShell
        title="Admin · Products"
        action={<Button onClick={() => setCreateOpen(true)}>+ New product</Button>}
        error={error}
        loading={!products && !error}
        empty={
          products && products.length === 0 ? (
            <Text c="dimmed">
              No products yet. Click <strong>+ New product</strong> to create the first one.
            </Text>
          ) : null
        }
      >
        {products && products.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Display name</th>
                <th>Slug</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} {...clickableRow(() => setEditing(p))}>
                  <td style={{ fontWeight: 500 }}>{p.displayName}</td>
                  <td className="text-muted">
                    <code>{p.slug}</code>
                  </td>
                  <td className="text-muted">{p.description ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ListPageShell>

      {createOpen && (
        <ProductFormModal
          onClose={() => setCreateOpen(false)}
          initial={null}
          onSaved={() => {
            setCreateOpen(false)
            reload()
          }}
        />
      )}
      {editing && (
        <ProductFormModal
          onClose={() => setEditing(null)}
          initial={editing}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
          onDeleted={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
    </>
  )
}

// Conditionally mounted by the caller (create: `{createOpen && …}`, edit:
// `{editing && …}`), so state initialises from `initial` on every open via
// the useState initial values — no `opened` prop / reset effect needed.
function ProductFormModal({
  onClose,
  initial,
  onSaved,
  onDeleted
}: {
  onClose: () => void
  initial: ProductRef | null
  onSaved: () => void
  onDeleted?: () => void
}) {
  const dialogs = useDialogs()
  const isEdit = !!initial
  const [slug, setSlug] = useState(initial?.slug ?? '')
  // In create mode the slug auto-fills from the name until the user edits
  // it; in edit mode it starts "touched" so we never overwrite the
  // existing slug.
  const [slugTouched, setSlugTouched] = useState(isEdit)
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const { busy, error, run: withBusy } = useBusyAction({ explain })

  // Create-mode live suggestion: `prod-<slugified-name>` until touched.
  useEffect(() => {
    if (!isEdit && !slugTouched) {
      setSlug(displayName.trim() ? suggestSlug('product', displayName) : '')
    }
  }, [isEdit, slugTouched, displayName])

  const submit = () =>
    withBusy(
      async () => {
        if (isEdit && initial) {
          const trimmedSlug = slug.trim()
          await adminPatchProduct(initial.id, {
            // Send slug only when it changed, so a grandfathered (pre-prefix)
            // product can be edited without being forced to re-slug; the
            // `prod-` prefix is enforced only on a real rename.
            ...(trimmedSlug !== initial.slug ? { slug: trimmedSlug } : {}),
            displayName: displayName.trim(),
            description: description.trim() || null
          })
        } else {
          await adminCreateProduct({
            slug: slug.trim(),
            displayName: displayName.trim(),
            description: description.trim() || null
          })
        }
        onSaved()
      },
      isEdit ? 'Save' : 'Create'
    )

  // The confirm dialog stays outside `withBusy` so the Delete button
  // doesn't show busy while the dialog is open.
  async function onDelete() {
    if (!initial) return
    const ok = await dialogs.confirm({
      title: 'Delete product?',
      message: `Delete product "${initial.displayName}"?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await withBusy(async () => {
      await adminDeleteProduct(initial.id)
      onDeleted?.()
    }, 'Delete')
  }

  return (
    <FormModalShell
      title={isEdit ? 'Edit product' : 'New product'}
      error={error}
      busy={busy}
      submitLabel={isEdit ? 'Save' : 'Create'}
      submitDisabled={!slug.trim() || !displayName.trim()}
      onSubmit={submit}
      onClose={onClose}
      footerLeft={
        isEdit && onDeleted ? (
          <Button variant="default" color="red" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
        ) : undefined
      }
    >
      <TextInput
        label="Display name"
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
      />
      <TextInput
        label="Slug"
        value={slug}
        onChange={(e) => {
          setSlugTouched(true)
          setSlug(e.currentTarget.value)
        }}
        description="Auto-filled from the name; edit to customise. Must start with prod-."
      />
      <TextInput
        label="Description"
        value={description ?? ''}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
    </FormModalShell>
  )
}

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    409: 'That slug is already taken.'
  })
}
