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
import { slugifyHeading } from '@ctxlayer/shared'
import type * as Y from 'yjs'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'

export interface CollaborationConfig {
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
   * Slash-menu "Link to doc" handler. When the user picks the item
   * the wrapper awaits this; on resolution to `{label, href}` it
   * inserts the link inline. Resolving to `null` (e.g. user closes
   * the picker) is a no-op. Omit to hide the item entirely.
   */
  resolveDocLink?: () => Promise<{ label: string; href: string } | null>
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
        core.replaceBlocks(core.document, blocks as Parameters<typeof core.replaceBlocks>[1])
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

  // Intercept clicks on internal SPA links (e.g. /app/docs/<id>) so
  // they navigate via React Router instead of triggering a full page
  // load. Modifier keys + non-primary buttons fall through to the
  // browser so "open in new tab" still works.
  const nav = useNavigate()
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      const anchor = (e.target as HTMLElement | null)?.closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href')
      if (!href || !href.startsWith('/app/')) return
      // Respect target="_blank" / explicit download even on internal links.
      if (anchor.target && anchor.target !== '' && anchor.target !== '_self') return
      e.preventDefault()
      nav(href)
    }
    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
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
                      title: 'Link to doc',
                      subtext: 'Pick another document to link to',
                      aliases: ['doc', 'link', 'reference', 'ref'],
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
              {getFormattingToolbarItems()}
              {resolveDocLinkRef.current && <DocLinkToolbarButton resolveRef={resolveDocLinkRef} />}
            </FormattingToolbar>
          )}
        />
      </BlockNoteView>
    </div>
  )
})

/**
 * Toolbar button that wraps the current selection in an internal
 * doc link. Sits next to BlockNote's default "Create Link" button —
 * that one is for arbitrary URLs; this one resolves to a doc in our
 * library via the host-provided picker.
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
      const path = stack.map((s) => s.slug).filter(Boolean).join('/')
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
      mainTooltip="Link to doc"
      label="Link to doc"
      icon={<span aria-hidden>🔗</span>}
      onClick={async () => {
        const link = await resolveRef.current?.()
        if (!link) return
        editor.createLink(link.href)
      }}
    >
      Doc
    </Components.FormattingToolbar.Button>
  )
}
