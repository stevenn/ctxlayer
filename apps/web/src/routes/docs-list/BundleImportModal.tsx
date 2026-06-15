import { useState } from 'react'
import { Alert, Button, FileButton, Group, Modal, Stack, Text, TextInput } from '@mantine/core'
import { type BundleFormat, type ImportBundleResult, importBundle } from '../../lib/api'
import { explain } from './helpers'

function detectFormat(name: string): BundleFormat | null {
  if (/\.tar\.gz$|\.tgz$/i.test(name)) return 'tar.gz'
  if (/\.zip$/i.test(name)) return 'zip'
  return null
}

/**
 * Import an OKF bundle archive (tar.gz / zip): its tree is grafted under a
 * chosen target folder. Format is detected from the filename.
 */
export function BundleImportModal({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportBundleResult | null>(null)
  const format = file ? detectFormat(file.name) : null

  async function submit() {
    if (!file || !format) return
    setBusy(true)
    setError(null)
    try {
      const res = await importBundle(file, { target: target.trim() || undefined, format })
      setResult(res)
      onImported()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} title="Import OKF bundle" centered>
      <Stack gap="md">
        {result ? (
          <Stack gap="sm">
            <Text fz="sm">
              Imported <strong>{result.created}</strong> doc{result.created === 1 ? '' : 's'}
              {result.skipped > 0 ? `, skipped ${result.skipped} non-doc file(s)` : ''}
              {result.okfVersion ? ` (OKF ${result.okfVersion})` : ''}.
            </Text>
            {result.errors.length > 0 && (
              <Alert color="yellow" variant="light" radius="sm" title="Some files were skipped">
                <Stack gap={2}>
                  {result.errors.slice(0, 8).map((e) => (
                    <Text key={e} fz="xs">
                      {e}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}
            <Group justify="flex-end">
              <Button onClick={onClose}>Done</Button>
            </Group>
          </Stack>
        ) : (
          <>
            <Text fz="sm" c="dimmed">
              Upload a tar.gz or zip OKF bundle. Its directory tree is grafted under the target
              folder; inter-doc links are re-pointed to the new docs.
            </Text>
            <Group gap="sm" align="flex-end">
              <FileButton onChange={setFile} accept=".tar.gz,.tgz,.zip,application/gzip,application/zip">
                {(props) => (
                  <Button variant="default" {...props}>
                    {file ? 'Change file' : 'Choose archive…'}
                  </Button>
                )}
              </FileButton>
              <Text c={file ? undefined : 'dimmed'} fz="sm" style={{ minWidth: 0, flex: 1 }}>
                {file ? file.name : 'No file selected'}
              </Text>
            </Group>
            {file && !format && (
              <Alert color="red" variant="light" radius="sm">
                Unrecognised archive — name must end in .tar.gz, .tgz, or .zip.
              </Alert>
            )}
            <TextInput
              label="Target folder"
              placeholder="/ (root) — e.g. /imported"
              value={target}
              onChange={(e) => setTarget(e.currentTarget.value)}
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
              <Button onClick={submit} loading={busy} disabled={!file || !format}>
                Import
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  )
}
