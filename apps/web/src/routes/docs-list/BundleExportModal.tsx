import { useState } from 'react'
import { Button, Group, Modal, Radio, Stack, Text, TextInput } from '@mantine/core'
import { type BundleFormat, bundleExportUrl } from '../../lib/api'

/**
 * Export a folder subtree as an OKF bundle archive. The user picks the bundle
 * root (blank = whole library) and the format; download goes straight to the
 * GET endpoint via an anchor (cookie-auth).
 */
export function BundleExportModal({ onClose }: { onClose: () => void }) {
  const [format, setFormat] = useState<BundleFormat>('tar.gz')
  const [folder, setFolder] = useState('')
  const root = folder.trim() || '/'

  return (
    <Modal opened onClose={onClose} title="Export OKF bundle" centered>
      <Stack gap="md">
        <Text fz="sm" c="dimmed">
          Package a folder subtree as an Open Knowledge Format bundle — Markdown + YAML
          frontmatter, a generated <code>index.md</code>, and inter-doc links as OKF paths.
          Leave the folder blank to export the whole library.
        </Text>
        <TextInput
          label="Bundle root (folder)"
          placeholder="/ (whole library)"
          value={folder}
          onChange={(e) => setFolder(e.currentTarget.value)}
        />
        <Radio.Group
          label="Format"
          value={format}
          onChange={(v) => setFormat(v as BundleFormat)}
        >
          <Group gap="md" mt={6}>
            <Radio value="tar.gz" label="tar.gz" />
            <Radio value="zip" label="zip" />
          </Group>
        </Radio.Group>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button component="a" href={bundleExportUrl(root, format)} download onClick={onClose}>
            Download
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
