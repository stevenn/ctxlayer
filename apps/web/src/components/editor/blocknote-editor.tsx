import { useEffect, useRef } from 'react'
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
import { filterSuggestionItems } from '@blocknote/core'
import { useMantineColorScheme } from '@mantine/core'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'

export interface BlockNoteEditorProps {
  /** Initial block tree (BlockNote JSON). Mutating this prop after
   *  first render does NOT re-mount the editor; remount by keying
   *  the component with the doc/revision id from the parent. */
  initialBlocks: unknown[]
  editable: boolean
  /** Fires on every keystroke. Callers debounce / hash for dirty tracking. */
  onChange?: (blocks: unknown[]) => void
  /**
   * Slash-menu "Link to doc" handler. When the user picks the item
   * the wrapper awaits this; on resolution to `{label, href}` it
   * inserts the link inline. Resolving to `null` (e.g. user closes
   * the picker) is a no-op. Omit to hide the item entirely.
   */
  resolveDocLink?: () => Promise<{ label: string; href: string } | null>
}

/**
 * Thin BlockNote wrapper. Exposes the data shape the rest of the app
 * cares about (`blocks: unknown[]`) so the editor library can be
 * swapped without touching routes. Adds:
 *   - Mantine color-scheme tracking
 *   - Esc-to-blur (drop edit mode without saving)
 *   - Optional "Link to doc" slash-menu item via resolveDocLink
 */
export function BlockNoteEditor(props: BlockNoteEditorProps) {
  const editor = useCreateBlockNote({
    initialContent:
      props.initialBlocks.length > 0
        ? (props.initialBlocks as Parameters<typeof useCreateBlockNote>[0] extends {
            initialContent?: infer T
          }
            ? T
            : never)
        : undefined
  })

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
  const hostRef = useRef<HTMLDivElement | null>(null)
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
    <div ref={hostRef} style={{ height: '100%' }}>
      <BlockNoteView
        editor={editor}
        editable={props.editable}
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
}

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
