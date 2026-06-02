import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Alert, Button, Group, Stack, Text, Title } from '@mantine/core'
import type { DocContent, SkillDetail, SkillLintFinding } from '@ctxlayer/shared'
import {
  fetchSkill,
  fetchSkillContent,
  fetchSkillRevisionContent,
  fetchSkillRevisions,
  patchSkill,
  putSkillContent,
  restoreSkillRevision
} from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import {
  BlockNoteEditor,
  type BlockNoteEditorHandle
} from '../../components/editor/blocknote-editor'
import {
  LeaveGuard,
  SAVE_IDLE_MS,
  SaveControls,
  type SaveState
} from '../../components/editor/save-controls'
import { RevisionHistoryButton } from '../../components/editor/revision-history'

// Hard ceiling on a single save request so a hung connection can't leave
// the editor stuck "saving…" forever — the abort surfaces as an error.
const SAVE_TIMEOUT_MS = 15_000

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
  const [dirty, setDirty] = useState(false)
  const [lintFindings, setLintFindings] = useState<SkillLintFinding[]>([])
  const dirtyRef = useRef(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Content of the last explicit save (or the doc as loaded). "Discard"
  // reverts to this; autosave does NOT advance it.
  const baselineRef = useRef<unknown[]>([])

  useEffect(() => {
    const ctrl = new AbortController()
    Promise.all([fetchSkill(skillId, ctrl.signal), fetchSkillContent(skillId, ctrl.signal)])
      .then(([d, content]) => {
        if (ctrl.signal.aborted) return
        setDetail(d)
        setInitialBlocks(content.blocks)
        baselineRef.current = content.blocks
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(explain(err))
      })
    return () => ctrl.abort()
  }, [skillId])

  // The single save path. `explicit` distinguishes a user Save/Discard
  // (clears the dirty state + advances the discard baseline, badge ->
  // "saved") from a background autosave (badge -> "autosaved", nav guard
  // stays armed). Returns true on success so the leave-guard can proceed.
  const doSave = useCallback(
    async (explicit: boolean): Promise<boolean> => {
      if (!editorRef.current) return false
      const blocks = editorRef.current.getBlocks()
      setSaveState({ kind: 'saving' })
      try {
        const res = await putSkillContent(skillId, { blocks }, AbortSignal.timeout(SAVE_TIMEOUT_MS))
        if (explicit) {
          baselineRef.current = blocks
          dirtyRef.current = false
          setDirty(false)
          setSaveState({ kind: 'saved' })
        } else if (dirtyRef.current) {
          setSaveState({ kind: 'autosaved' })
        }
        setLintFindings(res.lintFindings)
        return true
      } catch (err) {
        // Re-flag dirty so the next idle attempt retries.
        dirtyRef.current = true
        setSaveState({ kind: 'error', message: explain(err) })
        return false
      }
    },
    [skillId]
  )

  // Stable explicit-save wrapper for the Save button + leave guard.
  const saveExplicit = useCallback(() => doSave(true), [doSave])

  const discard = useCallback(async (): Promise<boolean> => {
    try {
      editorRef.current?.replaceBlocks(baselineRef.current)
    } catch (err) {
      // A failed revert must surface as an error, not throw — the leave
      // guard awaits this boolean and would otherwise hang open with no
      // feedback (and the inline Discard button would silently no-op).
      setSaveState({ kind: 'error', message: explain(err) })
      return false
    }
    return doSave(true)
  }, [doSave])

  // Restore: the server already wrote a new revision + snapshot. The skill
  // editor is single-writer REST (no Yjs), so we just push the restored
  // blocks into the editor view and advance the Discard baseline so the
  // change isn't flagged unsaved. A reload would also work here, but
  // replaceBlocks keeps the page state intact and matches the doc editor.
  const restoreFromHistory = useCallback((content: DocContent) => {
    try {
      editorRef.current?.replaceBlocks(content.blocks)
      baselineRef.current = content.blocks
      dirtyRef.current = false
      setDirty(false)
      setSaveState({ kind: 'saved' })
    } catch (err) {
      setSaveState({ kind: 'error', message: explain(err) })
    }
  }, [])

  const scheduleSave = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => {
      if (dirtyRef.current) void doSave(false)
    }, SAVE_IDLE_MS)
  }, [doSave])

  // Flush on unmount so a quick edit-then-navigate doesn't lose work.
  useEffect(
    () => () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      if (dirtyRef.current) void doSave(false)
    },
    [doSave]
  )

  const onChange = useCallback(() => {
    dirtyRef.current = true
    setDirty(true)
    // Dedupe so a burst of keystrokes doesn't re-render once already dirty.
    setSaveState((prev) => (prev.kind === 'dirty' ? prev : { kind: 'dirty' }))
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
          <SaveControls state={saveState} dirty={dirty} onSave={saveExplicit} onDiscard={discard} />
          <RevisionHistoryButton
            title={detail.title}
            list={() => fetchSkillRevisions(skillId)}
            fetchContent={(revId) => fetchSkillRevisionContent(skillId, revId)}
            restore={(revId) => restoreSkillRevision(skillId, { revisionId: revId })}
            onRestored={restoreFromHistory}
          />
          <StatusButton
            skillId={skillId}
            current={detail.status}
            onChanged={async () => {
              const fresh = await fetchSkill(skillId).catch(() => null)
              if (fresh) setDetail(fresh)
            }}
          />
          <Button size="xs" variant="default" component={Link} to="/app/admin/skills">
            Back to list
          </Button>
        </Group>
      </Group>

      {lintFindings.length > 0 && (
        <Alert color="yellow" variant="light" radius="sm">
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            ⚠ Schema linter found references that don't exist on attached upstreams
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {lintFindings.map((f, i) => (
              <li key={i} style={{ fontSize: 12 }}>
                <code>{f.reference}</code> — {f.kind}
                {f.upstreamSlug ? ` (${f.upstreamSlug}${f.toolName ? `.${f.toolName}` : ''})` : ''}
              </li>
            ))}
          </ul>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
            Warning only — your save succeeded.
          </div>
        </Alert>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'auto'
        }}
      >
        <BlockNoteEditor
          ref={editorRef}
          initialBlocks={initialBlocks}
          editable={true}
          onChange={onChange}
        />
      </div>

      <LeaveGuard dirty={dirty} onSave={saveExplicit} onDiscard={discard} />
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

// ----- helpers -----------------------------------------------------------

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    404: 'Skill not found.',
    413: 'Body too large.',
    400: 'Server rejected the body.'
  })
}
