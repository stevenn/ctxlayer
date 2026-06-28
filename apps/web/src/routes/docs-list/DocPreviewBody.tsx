import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader } from '@mantine/core'
import { useCreateBlockNote } from '@blocknote/react'
import { classifyHref, type DocSummary } from '@ctxlayer/shared'
import { fetchDocGitSource, fetchDocs } from '../../lib/api'
import { BlockNoteEditor } from '../../components/editor/blocknote-editor'

// Lazy chunk: this is the ONLY part of the docs workspace that pulls in
// BlockNote/ProseMirror, so the browse route's eager bundle stays light.
// It renders the selected doc's last-saved blocks read-only (no Yjs/collab
// session — browsing must never open a DocRoom). Doc-links remain clickable
// and navigate via resolveDocHref, keeping the preview a pure browse surface.
export function DocPreviewBody({
  docId,
  blocks,
  isGit
}: {
  docId: string
  blocks: unknown[]
  isGit: boolean
}) {
  // Headless instance used only to parse a git doc's raw markdown → blocks
  // when no snapshot exists yet (mirrors the editor's first-open path).
  const parser = useCreateBlockNote()
  // null = still resolving the git fallback; otherwise the blocks to render.
  const [resolved, setResolved] = useState<unknown[] | null>(() =>
    blocks.length > 0 || !isGit ? blocks : null
  )

  useEffect(() => {
    if (blocks.length > 0 || !isGit) {
      setResolved(blocks)
      return
    }
    // Git doc with no saved snapshot — fetch the canonical source.md and
    // parse it so the preview isn't blank until someone opens + saves it.
    const ctrl = new AbortController()
    setResolved(null)
    void (async () => {
      try {
        const { markdown } = await fetchDocGitSource(docId, ctrl.signal)
        if (ctrl.signal.aborted) return
        setResolved(markdown.trim() ? (parser.tryParseMarkdownToBlocks(markdown) as unknown[]) : [])
      } catch {
        if (!ctrl.signal.aborted) setResolved([])
      }
    })()
    return () => ctrl.abort()
  }, [docId, blocks, isGit, parser])

  // Slug → id resolution for OKF concept-path doc links (cached once).
  const docsCacheRef = useRef<Promise<DocSummary[]> | null>(null)
  const resolveDocHref = useCallback(async (href: string): Promise<string | null> => {
    const target = classifyHref(href)
    if (!target) return null
    if (target.kind === 'id') return target.id
    if (!docsCacheRef.current) docsCacheRef.current = fetchDocs()
    const docs = await docsCacheRef.current
    return docs.find((d) => d.slug === target.slug)?.id ?? null
  }, [])

  if (resolved === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
        <Loader size="sm" />
      </div>
    )
  }

  return (
    // `key` forces a fresh editor per doc — BlockNote reads initialContent
    // only at creation, so a doc switch must remount.
    <BlockNoteEditor
      key={docId}
      initialBlocks={resolved}
      editable={false}
      resolveDocHref={resolveDocHref}
    />
  )
}
