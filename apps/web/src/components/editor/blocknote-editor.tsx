import { useEffect } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import '@mantine/core/styles.css'

export interface BlockNoteEditorProps {
  /** Initial block tree (BlockNote JSON). Mutating this prop after
   *  first render does NOT re-mount the editor; remount by keying
   *  the component with the doc/revision id from the parent. */
  initialBlocks: unknown[]
  editable: boolean
  /** Fires on every keystroke. Callers debounce / hash for dirty tracking. */
  onChange?: (blocks: unknown[]) => void
}

/**
 * Thin BlockNote wrapper. The component intentionally exposes only
 * the data shape the rest of the app cares about (`blocks: unknown[]`)
 * so the editor library can be swapped without touching routes.
 */
export function BlockNoteEditor(props: BlockNoteEditorProps) {
  const editor = useCreateBlockNote({
    // BlockNote rejects an empty array; an empty doc is one empty
    // paragraph block. Use undefined so the editor seeds itself.
    initialContent:
      props.initialBlocks.length > 0
        ? (props.initialBlocks as Parameters<typeof useCreateBlockNote>[0] extends { initialContent?: infer T } ? T : never)
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

  return <BlockNoteView editor={editor} editable={props.editable} theme="light" />
}
