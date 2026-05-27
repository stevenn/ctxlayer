import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Alert, Badge, Button, Group, Stack, Text, Title } from '@mantine/core'
import type { SkillDetail } from '@ctxlayer/shared'
import {
  ApiError,
  ApiSchemaError,
  fetchSkill,
  fetchSkillContent,
  patchSkill,
  putSkillContent
} from '../../lib/api'
import {
  BlockNoteEditor,
  type BlockNoteEditorHandle
} from '../../components/editor/blocknote-editor'

const SAVE_IDLE_MS = 2_000

/**
 * Per-skill body editor. Simpler than docs-editor.tsx:
 *   - admin-only, no per-skill ACL
 *   - single-writer, no Yjs / WS collab (just REST PUT on debounce)
 *   - no folder / lock / sharing
 *   - metadata (title, description, status, attachments) lives in the
 *     SkillDrawer on /app/admin/skills; this page is body-focused
 */
export function AdminSkillEditor() {
  const { id } = useParams<{ id: string }>()
  const skillId = id ?? ''
  const editorRef = useRef<BlockNoteEditorHandle>(null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [initialBlocks, setInitialBlocks] = useState<unknown[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const dirtyRef = useRef(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    Promise.all([fetchSkill(skillId, ctrl.signal), fetchSkillContent(skillId, ctrl.signal)])
      .then(([d, content]) => {
        if (ctrl.signal.aborted) return
        setDetail(d)
        setInitialBlocks(content.blocks)
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(explain(err))
      })
    return () => ctrl.abort()
  }, [skillId])

  const save = useCallback(async () => {
    if (!dirtyRef.current) return
    if (!editorRef.current) return
    const blocks = editorRef.current.getBlocks()
    dirtyRef.current = false
    setSaveState({ kind: 'saving' })
    try {
      await putSkillContent(skillId, { blocks })
      setSaveState({ kind: 'saved', at: Date.now() })
    } catch (err) {
      // Re-flag dirty so the next idle attempt retries.
      dirtyRef.current = true
      setSaveState({ kind: 'error', message: explain(err) })
    }
  }, [skillId])

  const scheduleSave = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => {
      void save()
    }, SAVE_IDLE_MS)
  }, [save])

  // Flush on unmount so a quick edit-then-navigate doesn't lose work.
  useEffect(
    () => () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      if (dirtyRef.current) void save()
    },
    [save]
  )

  const onChange = useCallback(() => {
    dirtyRef.current = true
    setSaveState({ kind: 'dirty' })
    scheduleSave()
  }, [scheduleSave])

  if (error) {
    return (
      <Alert color="red" variant="light" radius="sm">
        {error}
      </Alert>
    )
  }

  if (!detail || initialBlocks === null) {
    return <Text c="dimmed">Loading…</Text>
  }

  return (
    <Stack gap="md" style={{ height: 'calc(100vh - 120px)' }}>
      <Group justify="space-between" align="center">
        <div>
          <Text fz="xs" c="dimmed">
            <Link to="/app/admin/skills" style={{ color: 'inherit' }}>
              Admin · Skills
            </Link>
            {' / '}
            <code style={{ fontSize: 11 }}>{detail.slug}</code>
          </Text>
          <Title order={2} fz={20} fw={600}>
            {detail.title}
          </Title>
          <Text fz="sm" c="dimmed">
            {detail.description}
          </Text>
        </div>
        <Group gap="xs">
          <SaveBadge state={saveState} />
          <StatusButton skillId={skillId} current={detail.status} onChanged={async () => {
            const fresh = await fetchSkill(skillId).catch(() => null)
            if (fresh) setDetail(fresh)
          }} />
          <Button
            size="xs"
            variant="default"
            component={Link}
            to="/app/admin/skills"
          >
            Back to list
          </Button>
        </Group>
      </Group>

      <div style={{ flex: 1, minHeight: 0, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'auto' }}>
        <BlockNoteEditor
          ref={editorRef}
          initialBlocks={initialBlocks}
          editable={true}
          onChange={onChange}
        />
      </div>
    </Stack>
  )
}

// ----- inline status toggle ----------------------------------------------

function StatusButton({
  skillId,
  current,
  onChanged
}: {
  skillId: string
  current: 'draft' | 'published' | 'archived'
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const next = current === 'published' ? 'draft' : 'published'
  const label = current === 'published' ? 'Unpublish' : 'Publish'
  return (
    <Button
      size="xs"
      variant={current === 'published' ? 'default' : 'filled'}
      color={current === 'published' ? 'gray' : 'green'}
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await patchSkill(skillId, { status: next })
          await onChanged()
        } finally {
          setBusy(false)
        }
      }}
    >
      {label}
    </Button>
  )
}

// ----- save-state badge --------------------------------------------------

type SaveState =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }

function SaveBadge({ state }: { state: SaveState }) {
  if (state.kind === 'idle') return null
  if (state.kind === 'dirty')
    return (
      <Badge color="yellow" variant="light">
        unsaved
      </Badge>
    )
  if (state.kind === 'saving')
    return (
      <Badge color="blue" variant="light">
        saving…
      </Badge>
    )
  if (state.kind === 'saved') {
    const seconds = Math.floor((Date.now() - state.at) / 1000)
    return (
      <Badge color="green" variant="light">
        saved {seconds}s ago
      </Badge>
    )
  }
  return (
    <Badge color="red" variant="light" title={state.message}>
      save failed
    </Badge>
  )
}

// ----- helpers -----------------------------------------------------------

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 401)
    return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError && err.status === 403) return 'Admin permission required.'
  if (err instanceof ApiError && err.status === 404) return 'Skill not found.'
  if (err instanceof ApiError && err.status === 413) return 'Body too large.'
  if (err instanceof ApiError && err.status === 400) return 'Server rejected the body.'
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  if (err instanceof Error) return err.message
  return 'Could not reach the server.'
}
