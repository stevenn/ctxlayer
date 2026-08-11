import type { ReactNode } from 'react'
import { Alert, Button, Group, Modal, Stack } from '@mantine/core'
import type { MantineSize } from '@mantine/core'

/**
 * The chrome every create/edit modal repeats (2026-08 review theme D):
 * `<Modal opened …>` + `<Stack>` + fields + error `<Alert>` + the
 * Cancel/submit footer. The FIELDS stay hand-written JSX in the caller —
 * nothing about field layout is configured here.
 *
 * House convention preserved: modals are conditionally MOUNTED by the
 * caller (`{open && <XModal …/>}`), so `opened` is a literal `true` and
 * there is no reset effect.
 *
 * `errorFirst` renders the Alert above the fields (AttachModal /
 * CreateSkillModal ordering); `footerLeft` fills a `space-between`
 * footer slot (products' Delete button).
 */
export function FormModalShell({
  title,
  size,
  centered = true,
  error,
  errorFirst = false,
  busy,
  submitLabel,
  submitDisabled = false,
  onSubmit,
  onClose,
  footerLeft,
  children
}: {
  title: ReactNode
  size?: MantineSize | (string & {})
  centered?: boolean
  error: string | null
  errorFirst?: boolean
  busy: boolean
  submitLabel: string
  submitDisabled?: boolean
  onSubmit: () => void
  onClose: () => void
  footerLeft?: ReactNode
  children: ReactNode
}) {
  const alert = error ? (
    <Alert color="red" variant="light" radius="sm">
      {error}
    </Alert>
  ) : null
  return (
    <Modal opened onClose={onClose} title={title} centered={centered} size={size}>
      <Stack gap="md">
        {errorFirst && alert}
        {children}
        {!errorFirst && alert}
        <Group justify={footerLeft ? 'space-between' : 'flex-end'} gap="xs">
          {footerLeft}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={onSubmit} loading={busy} disabled={submitDisabled}>
              {submitLabel}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  )
}
