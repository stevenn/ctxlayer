import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Button,
  FileButton,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import { useCreateBlockNote } from '@blocknote/react'
import type { DocSummary, UserSummary } from '@ctxlayer/shared'
import { ApiError, ApiSchemaError, createDoc, fetchDocs, putDocContent } from '../lib/api'

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; docs: DocSummary[] }
  | { kind: 'error'; message: string }

export function DocsList() {
  const nav = useNavigate()
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // Client-side filter over the list. Title / slug / creator / kind
  // are all matched case-insensitively. RAG search lives behind MCP
  // (`search_docs`) — this bar is for "find a doc I know exists".
  const [query, setQuery] = useState('')

  const reload = useCallback((signal?: AbortSignal) => {
    setStatus({ kind: 'loading' })
    fetchDocs(signal).then(
      (docs) => {
        if (!signal?.aborted) setStatus({ kind: 'ready', docs })
      },
      (err) => {
        if (signal?.aborted) return
        setStatus({ kind: 'error', message: explain(err) })
      }
    )
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    reload(ctrl.signal)
    return () => ctrl.abort()
  }, [reload])

  return (
    <>
      <Group justify="space-between" align="center" mb="md" gap="md" wrap="nowrap">
        <Title order={2} fz={20} fw={600} style={{ whiteSpace: 'nowrap' }}>
          Docs library
        </Title>
        <TextInput
          placeholder="Filter by title, slug, creator…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          size="sm"
          style={{ flex: 1, maxWidth: 360 }}
          aria-label="Filter docs"
        />
        <Menu shadow="md" position="bottom-end" withinPortal>
          <Menu.Target>
            <Button>+ New doc</Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => setCreateOpen(true)}>Blank doc</Menu.Item>
            <Menu.Item onClick={() => setImportOpen(true)}>Import markdown…</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      {status.kind === 'loading' && <Text c="dimmed">Loading…</Text>}

      {status.kind === 'error' && (
        <Stack gap="xs">
          <Alert color="red" variant="light" radius="sm">
            {status.message}
          </Alert>
          <Button variant="default" onClick={() => reload()} w={120}>
            Retry
          </Button>
        </Stack>
      )}

      {status.kind === 'ready' && status.docs.length === 0 && (
        <Text c="dimmed">
          No docs yet. Click <strong>+ New doc</strong> to create the first one.
        </Text>
      )}

      {status.kind === 'ready' &&
        status.docs.length > 0 &&
        (() => {
          const filtered = filterDocs(status.docs, query)
          if (filtered.length === 0) {
            return (
              <Text c="dimmed">
                No docs match <code>{query}</code>.{' '}
                <Text component="span" size="sm" c="dimmed">
                  ({status.docs.length} in library)
                </Text>
              </Text>
            )
          }
          return (
            <>
              {query && (
                <Text c="dimmed" fz="xs" mb="xs">
                  Showing {filtered.length} of {status.docs.length}
                </Text>
              )}
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Created by</th>
                    <th>Last edited by</th>
                    <th style={{ textAlign: 'right' }}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id} onClick={() => nav(`/app/docs/${d.id}`)}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{d.title}</div>
                        <div className="text-dim" style={{ fontSize: 12, marginTop: 2 }}>
                          {d.slug} · {d.kind}
                        </div>
                      </td>
                      <td className="text-muted">{personLabel(d.createdBy)}</td>
                      <td className="text-muted">
                        {/* never-edited fallback: implicit "creator" attribution */}
                        {personLabel(d.updatedBy ?? d.createdBy)}
                      </td>
                      <td className="text-muted" style={{ textAlign: 'right' }}>
                        {formatRelative(d.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        })()}

      <BlankDocModal opened={createOpen} onClose={() => setCreateOpen(false)} />
      <ImportDocModal opened={importOpen} onClose={() => setImportOpen(false)} />
    </>
  )
}

// ----- Blank doc modal ---------------------------------------------------

function BlankDocModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const nav = useNavigate()
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) {
      setTitle('')
      setError(null)
    }
  }, [opened])

  async function submit() {
    const t = title.trim()
    if (!t) return
    setBusy(true)
    setError(null)
    try {
      const { id } = await createDoc({ title: t })
      onClose()
      nav(`/app/docs/${id}`)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New doc" centered>
      <Stack gap="md">
        <TextInput
          label="Title"
          placeholder="e.g. API Guidelines"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!title.trim()}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ----- Import-markdown modal ---------------------------------------------

function ImportDocModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const nav = useNavigate()
  // Headless editor instance used only to parse markdown → blocks.
  // Created once per modal lifetime; never rendered.
  const parser = useCreateBlockNote()
  const [title, setTitle] = useState('')
  // Tracks whether the user has manually edited the title. Once they
  // have, picking a new file should NOT overwrite their choice.
  const [titleTouched, setTitleTouched] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) {
      setTitle('')
      setTitleTouched(false)
      setFile(null)
      setError(null)
    }
  }, [opened])

  function onFile(f: File | null) {
    setFile(f)
    if (f && !titleTouched) {
      // Strip the common markdown extensions; leave anything else
      // (e.g. .txt, no extension) intact.
      setTitle(f.name.replace(/\.(md|mdown|markdown|mkd|mdx|txt)$/i, ''))
    }
  }

  async function submit() {
    if (!file || !title.trim()) return
    setBusy(true)
    setError(null)
    try {
      const text = await file.text()
      const blocks = parser.tryParseMarkdownToBlocks(text)
      const { id } = await createDoc({ title: title.trim() })
      try {
        await putDocContent(id, { blocks: blocks as unknown[] })
      } catch (err) {
        // Doc was created but content save failed — surface clearly.
        throw new Error(
          `Doc was created but the content upload failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      onClose()
      nav(`/app/docs/${id}`)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Import markdown" centered>
      <Stack gap="md">
        <Group gap="sm" align="flex-end">
          <FileButton
            onChange={onFile}
            accept=".md,.markdown,.mdown,.mkd,.mdx,.txt,text/markdown,text/plain"
          >
            {(props) => (
              <Button variant="default" {...props}>
                {file ? 'Change file' : 'Choose file…'}
              </Button>
            )}
          </FileButton>
          <Text c={file ? undefined : 'dimmed'} fz="sm" style={{ minWidth: 0, flex: 1 }}>
            {file ? file.name : 'No file selected'}
          </Text>
        </Group>

        <TextInput
          label="Title"
          placeholder="Pick a file to autofill, or type a title"
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value)
            setTitleTouched(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />

        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!file || !title.trim()}>
            Import
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ----- helpers -----------------------------------------------------------

export function personLabel(u: UserSummary | null | undefined): string {
  if (!u) return '—'
  if (u.name && u.name.length > 0) return u.name
  const at = u.email.indexOf('@')
  return at > 0 ? u.email.slice(0, at) : u.email
}

function filterDocs(docs: DocSummary[], query: string): DocSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return docs
  return docs.filter((d) => {
    if (d.title.toLowerCase().includes(q)) return true
    if (d.slug.toLowerCase().includes(q)) return true
    if (d.kind.toLowerCase().includes(q)) return true
    const creator = personLabel(d.createdBy).toLowerCase()
    if (creator.includes(q)) return true
    const editor = personLabel(d.updatedBy ?? d.createdBy).toLowerCase()
    if (editor.includes(q)) return true
    return false
  })
}

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 401)
    return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError && err.status === 413)
    return 'The markdown file is too large (max 2 MB).'
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  if (err instanceof Error) return err.message
  return 'Could not reach the server.'
}

function formatRelative(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}
