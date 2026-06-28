import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, FileButton, Group, Modal, Stack, Text, TextInput } from '@mantine/core'
import { useCreateBlockNote } from '@blocknote/react'
import { parseFrontmatter } from '@ctxlayer/shared'
import { createDoc, putDocContent } from '../../lib/api'
import { useSlugSuggest } from '../../lib/use-slug-suggest'
import { explain } from './helpers'

// ----- Import-markdown modal ---------------------------------------------

// Conditionally mounted by the caller (`{importOpen && <ImportDocModal/>}`),
// so all state resets for free on close — no `opened` prop / reset effect.
export function ImportDocModal({ onClose }: { onClose: () => void }) {
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
  const slugField = useSlugSuggest('doc', title)

  async function onFile(f: File | null) {
    setFile(f)
    if (f && !titleTouched) {
      // Strip the common markdown extensions; leave anything else
      // (e.g. .txt, no extension) intact. An OKF `title` in the file's
      // frontmatter wins over the filename.
      let next = f.name.replace(/\.(md|mdown|markdown|mkd|mdx|txt)$/i, '')
      try {
        const fmTitle = parseFrontmatter(await f.text()).known.title?.trim()
        if (fmTitle) next = fmTitle
      } catch {
        // fall back to the filename-derived title
      }
      setTitle(next)
    }
  }

  async function submit() {
    if (!file || !title.trim()) return
    setBusy(true)
    setError(null)
    try {
      const text = await file.text()
      // Split OKF frontmatter off the body: parse blocks from the body only
      // (so YAML doesn't render as a paragraph), and carry the metadata onto
      // the doc — tags, the rail fields, and the raw block for round-trip.
      const { body, raw, known } = parseFrontmatter(text)
      const blocks = parser.tryParseMarkdownToBlocks(body)
      const { id } = await createDoc({
        title: title.trim(),
        slug: slugField.slug.trim() || undefined,
        docType: known.type ?? undefined,
        description: known.description ?? undefined,
        resource: known.resource ?? undefined,
        tags: known.tags,
        frontmatter: raw ?? undefined
      })
      try {
        await putDocContent(id, { blocks: blocks as unknown[] })
      } catch (err) {
        // Doc was created but content save failed — surface clearly.
        throw new Error(
          `Doc was created but the content upload failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      onClose()
      // Open the freshly-imported doc in the editor (not the preview).
      nav(`/app/docs/${id}/edit`)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} title="Import markdown" centered>
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

        <TextInput
          label="Slug"
          value={slugField.slug}
          onChange={(e) => slugField.setSlug(e.currentTarget.value)}
          description="Auto-filled from the title; edit to customise. Must start with doc-."
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
