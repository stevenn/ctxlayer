import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Stack,
  Text,
  TextInput
} from '@mantine/core'
import type { DocEditorsResponse, UserSearchResult } from '@ctxlayer/shared'
import { addDocEditor, fetchDocEditors, removeDocEditor, searchUsers } from '../lib/api'

interface Props {
  docId: string
  onClose: () => void
}

export function SharingDialog({ docId, onClose }: Props) {
  const [editors, setEditors] = useState<DocEditorsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserSearchResult>([])

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = await fetchDocEditors(docId, signal)
        if (!signal?.aborted) setEditors(data)
      } catch (err) {
        if (signal?.aborted) return
        setError(`Could not load sharing: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [docId]
  )

  useEffect(() => {
    const ctrl = new AbortController()
    reload(ctrl.signal)
    return () => ctrl.abort()
  }, [reload])

  // Debounced search. Server returns [] for prefixes < 2 chars; we
  // still call so cleared queries reset the dropdown.
  const debouncer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (debouncer.current) clearTimeout(debouncer.current)
    debouncer.current = setTimeout(async () => {
      if (query.trim().length < 2) {
        setResults([])
        return
      }
      try {
        setResults(await searchUsers(query.trim()))
      } catch {
        setResults([])
      }
    }, 180)
    return () => {
      if (debouncer.current) clearTimeout(debouncer.current)
    }
  }, [query])

  async function withBusy(action: () => Promise<void>, label: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      // Surface failures so the user sees why the checkbox or list
      // didn't move. Without this the UI silently reverts and looks
      // broken.
      setError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function grantUser(userId: string) {
    await withBusy(async () => {
      await addDocEditor(docId, { kind: 'user', userId })
      setQuery('')
      setResults([])
      await reload()
    }, 'Grant')
  }

  async function revokeUser(userId: string) {
    await withBusy(async () => {
      await removeDocEditor(docId, 'user', userId)
      await reload()
    }, 'Revoke')
  }

  async function toggleEveryone(next: boolean) {
    await withBusy(
      async () => {
        if (next) await addDocEditor(docId, { kind: 'everyone' })
        else await removeDocEditor(docId, 'everyone', '')
        await reload()
      },
      next ? 'Grant everyone' : 'Revoke everyone'
    )
  }

  return (
    <Modal opened onClose={onClose} title="Sharing" centered size="md">
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}

        <Checkbox
          label="Anyone in the org can edit"
          checked={editors?.everyone ?? false}
          disabled={!editors || busy}
          onChange={(e) => toggleEveryone(e.currentTarget.checked)}
        />

        <Stack gap={6}>
          <Text fz="sm" c="dimmed">
            Add by email
          </Text>
          <TextInput
            type="email"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="user@…"
            autoComplete="off"
          />
          {results.length > 0 && (
            <Stack gap={4}>
              {results.map((u) => (
                <Group
                  key={u.id}
                  justify="space-between"
                  px="sm"
                  py={6}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)'
                  }}
                >
                  <Text fz="sm">
                    {u.email}
                    {u.name ? ` · ${u.name}` : ''}
                  </Text>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={busy}
                    onClick={() => grantUser(u.id)}
                  >
                    Add
                  </Button>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>

        <Stack gap={6}>
          <Text fz="sm" c="dimmed">
            Editors
          </Text>
          {!editors && <Text c="dimmed">Loading…</Text>}
          {editors && editors.users.length === 0 && (
            <Text c="dimmed" fz="sm">
              {editors.everyone
                ? 'Anyone in the org can edit this doc.'
                : 'No editors granted yet.'}
            </Text>
          )}
          {editors && editors.users.length > 0 && (
            <Stack gap={0} style={{ borderTop: '1px solid var(--border)' }}>
              {editors.users.map((u) => (
                <Group
                  key={u.userId}
                  justify="space-between"
                  px="sm"
                  py={8}
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <Text fz="sm">
                    {u.email}
                    {u.name ? ` · ${u.name}` : ''}
                  </Text>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    disabled={busy}
                    onClick={() => revokeUser(u.userId)}
                    aria-label={`Remove ${u.email}`}
                  >
                    ×
                  </ActionIcon>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Modal>
  )
}
