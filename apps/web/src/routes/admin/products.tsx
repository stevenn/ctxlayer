import { useEffect, useState } from 'react'
import { Alert, Button, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core'
import { type ProductRef, suggestSlug } from '@ctxlayer/shared'
import {
  adminCreateProduct,
  adminDeleteProduct,
  adminPatchProduct,
  fetchProducts
} from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import { useLoad } from '../../lib/use-load'
import { useDialogs } from '../../lib/dialogs'

export function AdminProducts() {
  const { data: products, error, reload } = useLoad(fetchProducts, [], { explain })
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<ProductRef | null>(null)

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Products
        </Title>
        <Button onClick={() => setCreateOpen(true)}>+ New product</Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {!products && !error && <Text c="dimmed">Loading…</Text>}
      {products && products.length === 0 && (
        <Text c="dimmed">
          No products yet. Click <strong>+ New product</strong> to create the first one.
        </Text>
      )}
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
              <tr key={p.id} onClick={() => setEditing(p)}>
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

      <ProductFormModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        initial={null}
        onSaved={() => {
          setCreateOpen(false)
          reload()
        }}
      />
      {editing && (
        <ProductFormModal
          opened
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

function ProductFormModal({
  opened,
  onClose,
  initial,
  onSaved,
  onDeleted
}: {
  opened: boolean
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
  const [slugTouched, setSlugTouched] = useState(false)
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) {
      setBusy(false)
      setError(null)
    }
    if (opened && initial) {
      setSlug(initial.slug)
      setSlugTouched(true)
      setDisplayName(initial.displayName)
      setDescription(initial.description ?? '')
    } else if (opened) {
      setSlug('')
      setSlugTouched(false)
      setDisplayName('')
      setDescription('')
    }
  }, [opened, initial])

  // Create-mode live suggestion: `prod-<slugified-name>` until touched.
  useEffect(() => {
    if (!isEdit && !slugTouched) {
      setSlug(displayName.trim() ? suggestSlug('product', displayName) : '')
    }
  }, [isEdit, slugTouched, displayName])

  async function submit() {
    if (!slug.trim() || !displayName.trim()) return
    setBusy(true)
    setError(null)
    try {
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
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function onDelete() {
    if (!initial) return
    const ok = await dialogs.confirm({
      title: 'Delete product?',
      message: `Delete product "${initial.displayName}"?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await adminDeleteProduct(initial.id)
      onDeleted?.()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={isEdit ? 'Edit product' : 'New product'}
      centered
    >
      <Stack gap="md">
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
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <Group justify="space-between" gap="xs">
          <div>
            {isEdit && onDeleted && (
              <Button variant="default" color="red" onClick={onDelete} disabled={busy}>
                Delete
              </Button>
            )}
          </div>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy} disabled={!slug.trim() || !displayName.trim()}>
              {isEdit ? 'Save' : 'Create'}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  )
}

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    409: 'That slug is already taken.'
  })
}
