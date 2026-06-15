import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
  type DefaultReactSuggestionItem
} from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import {
  filterSuggestionItems,
  type BlockNoteEditor as BlockNoteEditorCore,
  type BlockNoteEditorOptions
} from '@blocknote/core'
import { Loader, useMantineColorScheme } from '@mantine/core'
import { classifyHref, slugifyHeading } from '@ctxlayer/shared'
import type * as Y from 'yjs'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'

interface CollaborationConfig {
  /** Yjs provider exposing `.awareness` (for y-prosemirror cursor plugin). */
  provider: {
    awareness: unknown
    /**
     * Optional "doc fully loaded" signal: fires once the initial sync
     * (first syncStep2) has been applied, so the editor's content is
     * materialized. When present, the editor shows a loading overlay and
     * blocks editing until it fires — otherwise a large doc renders empty
     * for a beat and looks like a blank doc you can type into. Returns an
     * unsubscribe fn. Omit (or provider lacking it) → no overlay.
     */
    onSynced?: (cb: () => void) => () => void
  }
  /** Y.XmlFragment that holds the editor doc. */
  fragment: Y.XmlFragment
  /** Local user identity shown in collaborative cursors / selections. */
  user: { name: string; color: string }
}

export interface BlockNoteEditorProps {
  /** Initial block tree (BlockNote JSON). Used in REST mode; ignored
   *  when `collaboration` is provided (Yjs owns the doc state). */
  initialBlocks: unknown[]
  editable: boolean
  /** Fires on every keystroke. Callers debounce / hash for dirty
   *  tracking. In collab mode prefer subscribing to the Y.Doc itself. */
  onChange?: (blocks: unknown[]) => void
  /**
   * Unified "Link" handler. When the user invokes the link tool the
   * wrapper awaits this; on resolution to `{label, href}` it inserts the
   * link (a doc concept-path or an external URL). `null` (picker closed)
   * is a no-op. Omit to hide the tool entirely (read-only docs).
   */
  resolveDocLink?: () => Promise<{ label: string; href: string } | null>
  /**
   * Resolve an in-app doc-link href (an OKF concept path, or a legacy
   * `/app/docs/{id}`) to a doc id, for click navigation. Returns null for a
   * dangling/unknown link. External URLs are never passed here. Provided
   * regardless of edit permission so links are clickable read-only.
   */
  resolveDocHref?: (href: string) => Promise<string | null>
  /** Wire BlockNote's Yjs collab extension. Omit for REST autosave mode. */
  collaboration?: CollaborationConfig
}

/** Imperative handle so the host route can seed the Y.Doc from existing
 *  JSON when migrating an old doc into collab. */
export interface BlockNoteEditorHandle {
  replaceBlocks(blocks: unknown[]): void
  getBlocks(): unknown[]
  /** Current document rendered to markdown (BlockNote's lossy export). */
  getMarkdown(): Promise<string>
  /**
   * Scroll to (and briefly highlight) the heading whose slugified path
   * matches `anchor` (e.g. "api-guidelines/auth/tokens"). Used by search
   * deep-links (?section=). Returns true if a heading was found and
   * scrolled to; false if no match (caller should fail soft — leave the
   * doc at the top). Tries a full ancestor-path match first, then falls
   * back to the deepest segment alone.
   */
  scrollToHeadingPath(anchor: string): boolean
}

/**
 * Thin BlockNote wrapper. Exposes the data shape the rest of the app
 * cares about (`blocks: unknown[]`) so the editor library can be
 * swapped without touching routes. Adds:
 *   - Mantine color-scheme tracking
 *   - Esc-to-blur (drop edit mode without saving)
 *   - Optional "Link to doc" slash-menu item via resolveDocLink
 */
export const BlockNoteEditor = forwardRef<BlockNoteEditorHandle, BlockNoteEditorProps>(
  function BlockNoteEditor(props, ref) {
    // biome-ignore lint/suspicious/noExplicitAny: BlockNote's option generics require `any` here
    type EditorOpts = Partial<BlockNoteEditorOptions<any, any, any>>
    // `collaboration` is the source of truth when present, so we must
    // not pass `initialContent` (BlockNote rejects both together).
    const editorOptions: EditorOpts = props.collaboration
      ? {
          collaboration: {
            provider: props.collaboration.provider,
            fragment: props.collaboration.fragment,
            user: props.collaboration.user
          } as unknown as EditorOpts['collaboration']
        }
      : {
          initialContent:
            props.initialBlocks.length > 0
              ? (props.initialBlocks as EditorOpts['initialContent'])
              : undefined
        }
    const editor = useCreateBlockNote(editorOptions)
    const hostRef = useRef<HTMLDivElement | null>(null)

    // Collab load gate. In collab mode the Y.Doc starts empty and the
    // server streams the content as a syncStep2 — for a large doc that's a
    // visible gap where the editor looks blank. We overlay a loader and
    // force the editor read-only until `onSynced` fires, so nobody mistakes
    // a still-loading doc for an empty one and types into it. REST mode (no
    // provider, or a provider without `onSynced`) never gates.
    const provider = props.collaboration?.provider
    const [loading, setLoading] = useState<boolean>(() => !!provider?.onSynced)
    useEffect(() => {
      const subscribe = provider?.onSynced
      if (!provider || !subscribe) {
        setLoading(false)
        return
      }
      setLoading(true)
      // Call through the provider instance so `this` is bound — onSynced
      // reads instance state (extracting the method would detach it).
      const off = subscribe.call(provider, () => setLoading(false))
      return () => off?.()
    }, [provider])

    useImperativeHandle(
      ref,
      (): BlockNoteEditorHandle => ({
        replaceBlocks(blocks) {
          const core = editor as unknown as BlockNoteEditorCore
          // `editor.document` is the current top-level block list; replacing
          // it with the incoming blocks is the v0.51-supported way to swap
          // the entire doc programmatically. Casts because BlockNote types
          // the second arg with the editor's resolved schema generics.
          //
          // A document must always hold at least one block: replacing with an
          // empty list deletes the last block and leaves an invalid zero-block
          // doc, which makes the ProseMirror transaction throw. Discarding to
          // an empty baseline (e.g. on a freshly-created doc, whose snapshot is
          // `{ blocks: [] }`) must therefore land a single empty paragraph, not
          // nothing — otherwise Discard / Discard & leave throw and no-op.
          const next = (blocks as unknown[]).length > 0 ? blocks : [{ type: 'paragraph' }]
          core.replaceBlocks(core.document, next as Parameters<typeof core.replaceBlocks>[1])
        },
        getBlocks() {
          return (editor as unknown as BlockNoteEditorCore).document as unknown[]
        },
        getMarkdown() {
          const core = editor as unknown as BlockNoteEditorCore
          // BlockNote types this as sync in this version; wrap so the
          // handle stays Promise-shaped (it has been async in others).
          return Promise.resolve(core.blocksToMarkdownLossy(core.document))
        },
        scrollToHeadingPath(anchor) {
          const host = hostRef.current
          if (!host || !anchor) return false
          const blocks = (editor as unknown as BlockNoteEditorCore).document as unknown[]
          const blockId = findHeadingBlockId(blocks, anchor)
          if (!blockId) return false
          return flashBlock(host, blockId)
        }
      }),
      [editor]
    )

    // Bridge editor.onChange -> prop callback. The editor's onChange
    // returns an unsubscribe function from BlockNote v0.14+.
    useEffect(() => {
      if (!props.onChange) return
      const off = editor.onChange(() => {
        props.onChange?.(editor.document as unknown[])
      })
      return () => off?.()
    }, [editor, props.onChange])

    // Esc-to-blur: leave edit mode without saving. We listen at the
    // wrapper rather than relying on a ProseMirror keymap because
    // BlockNote already maps Esc to "close menus"; deferring one tick
    // lets that fire first, then we drop focus to leave edit mode.
    useEffect(() => {
      const host = hostRef.current
      if (!host) return
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return
        setTimeout(() => {
          const active = document.activeElement as HTMLElement | null
          if (active && host.contains(active) && typeof active.blur === 'function') {
            active.blur()
          }
        }, 0)
      }
      host.addEventListener('keydown', onKeyDown)
      return () => host.removeEventListener('keydown', onKeyDown)
    }, [editor])

    // Doc / external link navigation. We fully preempt BlockNote's own link
    // handling: it focuses + opens the link on mousedown, which otherwise drops
    // the editor into edit mode AND opens the raw href in a new tab (→
    // /app/search for an OKF path). A doc link routes in-app via React Router;
    // an external link opens in a new tab. Modified / non-primary clicks fall
    // through so native open-in-new-tab still works.
    const nav = useNavigate()
    const resolveDocHrefRef = useRef(props.resolveDocHref)
    resolveDocHrefRef.current = props.resolveDocHref
    useEffect(() => {
      const host = hostRef.current
      if (!host) return
      // Reduce an href to a classification. BlockNote can render it as a
      // resolved absolute URL, so a same-origin one is folded to its path.
      const classify = (anchor: HTMLAnchorElement) => {
        const raw = (anchor.getAttribute('href') ?? '').trim()
        if (!raw) return null
        let href = raw
        if (/^https?:\/\//i.test(raw)) {
          try {
            const u = new URL(raw)
            if (u.origin === window.location.origin) href = u.pathname + u.search + u.hash
          } catch {
            /* keep raw */
          }
        }
        return { href, target: classifyHref(href) }
      }
      const linkAt = (e: Event): HTMLAnchorElement | null => {
        const a = (e.target as HTMLElement | null)?.closest('a')
        return a && host.contains(a) ? (a as HTMLAnchorElement) : null
      }
      const plain = (e: MouseEvent) =>
        e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey

      // Preempt BlockNote's mousedown link handling (focus + open).
      const onMouseDown = (e: MouseEvent) => {
        const a = linkAt(e)
        if (plain(e) && a && classify(a)) {
          e.preventDefault()
          e.stopPropagation()
        }
      }
      const onClick = (e: MouseEvent) => {
        if (!plain(e)) return
        const a = linkAt(e)
        if (!a) return
        const c = classify(a)
        if (!c) return
        e.preventDefault()
        e.stopPropagation()
        if (!c.target) {
          // External link → new tab, so the open editor isn't lost.
          if (a.href) window.open(a.href, '_blank', 'noopener,noreferrer')
          return
        }
        // Defer the route change so the click finishes + BlockNote settles
        // before this editor unmounts (avoids a tiptap "view not available"
        // crash on the doc → doc swap). Carry the source doc id so the target
        // can offer a "back to source" link.
        const from = window.location.pathname.match(/\/app\/docs\/([^/?#]+)/)?.[1]
        const go = (path: string) =>
          window.setTimeout(() => nav(path, from ? { state: { fromDocId: from } } : undefined), 0)
        if (c.target.kind === 'id') {
          go(`/app/docs/${c.target.id}`)
          return
        }
        resolveDocHrefRef.current?.(c.href).then(
          (docId) => {
            if (docId) go(`/app/docs/${docId}`)
          },
          () => {}
        )
      }
      document.addEventListener('mousedown', onMouseDown, true)
      document.addEventListener('click', onClick, true)
      return () => {
        document.removeEventListener('mousedown', onMouseDown, true)
        document.removeEventListener('click', onClick, true)
      }
    }, [nav])

    const { colorScheme } = useMantineColorScheme()
    const resolved: 'light' | 'dark' =
      colorScheme === 'dark'
        ? 'dark'
        : colorScheme === 'light'
          ? 'light'
          : window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'

    // Snapshot the host callback in a ref so the SuggestionMenuController
    // closure always sees the latest version (host modal state can
    // change between renders).
    const resolveDocLinkRef = useRef(props.resolveDocLink)
    resolveDocLinkRef.current = props.resolveDocLink

    return (
      <div ref={hostRef} style={{ height: '100%', position: 'relative' }}>
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              // Opaque so the still-empty editor underneath doesn't read as
              // a blank document. Also captures pointer events → no clicks
              // reach the editor while it loads.
              background: 'var(--bg-surface)',
              color: 'var(--text-dim)',
              fontSize: 13
            }}
            aria-live="polite"
            aria-busy="true"
          >
            <Loader size="sm" />
            <span>Loading document…</span>
          </div>
        )}
        <BlockNoteView
          editor={editor}
          editable={props.editable && !loading}
          theme={resolved}
          slashMenu={false}
          formattingToolbar={false}
        >
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) => {
              const items: DefaultReactSuggestionItem[] = [
                ...(resolveDocLinkRef.current
                  ? [
                      {
                        title: 'Link',
                        subtext: 'Link to a doc or an external URL',
                        aliases: ['link', 'doc', 'url', 'reference', 'ref'],
                        group: 'Other',
                        icon: <span aria-hidden>🔗</span>,
                        onItemClick: async () => {
                          const link = await resolveDocLinkRef.current?.()
                          if (!link) return
                          editor.insertInlineContent([
                            {
                              type: 'link',
                              href: link.href,
                              content: link.label
                            }
                          ])
                        }
                      }
                    ]
                  : []),
                ...getDefaultReactSlashMenuItems(editor)
              ]
              return filterSuggestionItems(items, query)
            }}
          />
          <FormattingToolbarController
            formattingToolbar={() => (
              <FormattingToolbar>
                {/* Hide BlockNote's built-in URL-only link button: our unified
                    "Link" tool (DocLinkToolbarButton) handles docs + URLs. */}
                {getFormattingToolbarItems().filter((item) => item.key !== 'createLinkButton')}
                {resolveDocLinkRef.current && (
                  <DocLinkToolbarButton resolveRef={resolveDocLinkRef} />
                )}
              </FormattingToolbar>
            )}
          />
        </BlockNoteView>
      </div>
    )
  }
)

/**
 * The unified "Link" toolbar button. Replaces BlockNote's built-in
 * "Create Link" button (which is filtered out above) — the host picker it
 * opens handles BOTH a doc (inserts an OKF concept-path href) and an
 * external URL.
 *
 * `editor.createLink(url)` (no `text` arg) wraps the current selection
 * in a link with the given URL — selection text is preserved. The
 * ProseMirror selection survives the modal opening/closing because
 * focus moving to a DOM modal does not mutate the editor's state.
 */
// ----- heading deep-link resolution --------------------------------------

type AnyBlock = {
  id?: string
  type?: string
  props?: { level?: number }
  content?: unknown
  children?: unknown
}

/** Flatten a block's inline content into plain text (text + nested links). */
function blockPlainText(block: AnyBlock): string {
  const content = block.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const item of content as Array<Record<string, unknown>>) {
    if (typeof item?.text === 'string') out += item.text
    else if (Array.isArray(item?.content)) {
      for (const sub of item.content as Array<Record<string, unknown>>) {
        if (typeof sub?.text === 'string') out += sub.text
      }
    }
  }
  return out
}

/**
 * Walk the block tree in document order, maintaining a heading-level
 * stack (the same construction the server-side chunker uses), and find
 * the heading whose slugified ancestor-path matches `anchor`. Falls back
 * to the deepest path segment alone when no full path matches.
 */
function findHeadingBlockId(blocks: unknown[], anchor: string): string | null {
  const lastSeg = anchor.split('/').pop() ?? anchor
  const stack: { level: number; slug: string }[] = []
  let matchId: string | null = null
  let fallbackId: string | null = null

  const visit = (raw: unknown) => {
    if (matchId) return
    const block = raw as AnyBlock
    if (block?.type === 'heading' && typeof block.id === 'string') {
      const level = Number(block.props?.level) || 1
      const slug = slugifyHeading(blockPlainText(block))
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop()
      stack.push({ level, slug })
      const path = stack
        .map((s) => s.slug)
        .filter(Boolean)
        .join('/')
      if (path === anchor) matchId = block.id
      else if (!fallbackId && slug && slug === lastSeg) fallbackId = block.id
    }
    if (Array.isArray(block?.children)) block.children.forEach(visit)
  }
  blocks.forEach(visit)
  return matchId ?? fallbackId
}

/** Scroll a block (by its rendered data-id) into view and flash it. */
function flashBlock(host: HTMLElement, blockId: string): boolean {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(blockId) : blockId
  const el = host.querySelector(`[data-id="${escaped}"]`)
  if (!el) return false
  el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  el.classList.add('ctx-section-flash')
  window.setTimeout(() => el.classList.remove('ctx-section-flash'), 2000)
  return true
}

function DocLinkToolbarButton({
  resolveRef
}: {
  resolveRef: React.MutableRefObject<
    (() => Promise<{ label: string; href: string } | null>) | undefined
  >
}) {
  const Components = useComponentsContext()
  const editor = useBlockNoteEditor()
  if (!Components) return null
  return (
    <Components.FormattingToolbar.Button
      mainTooltip="Link (doc or URL)"
      label="Link"
      icon={<span aria-hidden>🔗</span>}
      onClick={async () => {
        const link = await resolveRef.current?.()
        if (!link) return
        editor.createLink(link.href)
      }}
    >
      Link
    </Components.FormattingToolbar.Button>
  )
}
