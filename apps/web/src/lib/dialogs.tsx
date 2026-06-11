import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core'

/**
 * Modal-based replacement for `window.confirm` / `window.alert` /
 * `window.prompt`. The provider holds at most one open dialog. Each
 * call returns a promise that resolves when the user picks an action
 * or dismisses the modal.
 *
 * Wrap the app once with <DialogProvider>; call `useDialogs()` inside
 * components and await the helpers.
 */

export type ConfirmOpts = {
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

type PromptOpts = {
  title: string
  message?: ReactNode
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}

type AlertOpts = {
  title: string
  message: ReactNode
  closeLabel?: string
}

type DialogState =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: 'alert'; opts: AlertOpts; resolve: () => void }
  | null

interface Dialogs {
  confirm: (opts: ConfirmOpts) => Promise<boolean>
  prompt: (opts: PromptOpts) => Promise<string | null>
  alert: (opts: AlertOpts) => Promise<void>
}

const DialogCtx = createContext<Dialogs | null>(null)

export function useDialogs(): Dialogs {
  const ctx = useContext(DialogCtx)
  if (!ctx) throw new Error('useDialogs must be used inside <DialogProvider>')
  return ctx
}

/**
 * Confirm helper for destructive actions triggered *inside a Drawer*. A confirm
 * Modal and a Mantine Drawer share the default z-index, and the drawer (its
 * portal mounts later) paints over the modal. Rather than fight z-index, this
 * slides the host drawer out of the way while the dialog is open and brings it
 * back when the user cancels. Bind the host drawer's `opened` to `hidden`:
 *
 *   const { hidden, confirm } = useDrawerConfirm()
 *   <Drawer opened={open && !hidden} ...>
 *   ...onClick={async () => { if (await confirm(opts)) doIt() }}
 *
 * Pass `{ keepHiddenOnConfirm: true }` for an action that UNMOUNTS the drawer on
 * success (e.g. delete) so it doesn't flash back in for a frame before closing.
 */
export function useDrawerConfirm() {
  const { confirm: base } = useDialogs()
  const [hidden, setHidden] = useState(false)
  const confirm = useCallback(
    async (opts: ConfirmOpts, o?: { keepHiddenOnConfirm?: boolean }): Promise<boolean> => {
      setHidden(true)
      const ok = await base(opts)
      // Restore the drawer on cancel; also on confirm unless the caller is
      // about to unmount it (delete), where a restore would flash.
      if (!(ok && o?.keepHiddenOnConfirm)) setHidden(false)
      return ok
    },
    [base]
  )
  // Force the host drawer back into view. Call this from a delete handler's
  // error path: with `keepHiddenOnConfirm` the drawer stays hidden after the
  // user confirms, so if the action then THROWS (and the drawer isn't
  // unmounted) the error would otherwise be invisible behind a hidden drawer.
  const reveal = useCallback(() => setHidden(false), [])
  return { hidden, confirm, reveal }
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null)
  const [promptValue, setPromptValue] = useState('')

  // Latest-state ref so the api callbacks (stable identity) can serialise
  // overlapping calls. If a dialog is already open we replace it with the
  // new one and resolve the older one with the "dismissed" answer.
  const currentRef = useRef<DialogState>(null)
  currentRef.current = state

  function resolveCurrentAsDismissed() {
    const cur = currentRef.current
    if (!cur) return
    if (cur.kind === 'confirm') cur.resolve(false)
    else if (cur.kind === 'prompt') cur.resolve(null)
    else cur.resolve()
  }

  const api: Dialogs = {
    confirm: useCallback(
      (opts) =>
        new Promise<boolean>((resolve) => {
          resolveCurrentAsDismissed()
          setState({ kind: 'confirm', opts, resolve })
        }),
      []
    ),
    prompt: useCallback(
      (opts) =>
        new Promise<string | null>((resolve) => {
          resolveCurrentAsDismissed()
          setPromptValue(opts.defaultValue ?? '')
          setState({ kind: 'prompt', opts, resolve })
        }),
      []
    ),
    alert: useCallback(
      (opts) =>
        new Promise<void>((resolve) => {
          resolveCurrentAsDismissed()
          setState({ kind: 'alert', opts, resolve })
        }),
      []
    )
  }

  function close(answer: () => void) {
    answer()
    setState(null)
  }

  return (
    <DialogCtx.Provider value={api}>
      {children}

      <Modal
        opened={state?.kind === 'confirm'}
        onClose={() => state?.kind === 'confirm' && close(() => state.resolve(false))}
        title={state?.kind === 'confirm' ? state.opts.title : undefined}
        centered
        size="sm"
      >
        {state?.kind === 'confirm' && (
          <Stack gap="md">
            <Text fz="sm">{state.opts.message}</Text>
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => close(() => state.resolve(false))}>
                {state.opts.cancelLabel ?? 'Cancel'}
              </Button>
              <Button
                color={state.opts.danger ? 'red' : undefined}
                onClick={() => close(() => state.resolve(true))}
                autoFocus
              >
                {state.opts.confirmLabel ?? 'Confirm'}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={state?.kind === 'prompt'}
        onClose={() => state?.kind === 'prompt' && close(() => state.resolve(null))}
        title={state?.kind === 'prompt' ? state.opts.title : undefined}
        centered
        size="sm"
      >
        {state?.kind === 'prompt' && (
          <Stack gap="md">
            {state.opts.message && <Text fz="sm">{state.opts.message}</Text>}
            <TextInput
              value={promptValue}
              onChange={(e) => setPromptValue(e.currentTarget.value)}
              placeholder={state.opts.placeholder}
              data-autofocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') close(() => state.resolve(promptValue))
              }}
            />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => close(() => state.resolve(null))}>
                {state.opts.cancelLabel ?? 'Cancel'}
              </Button>
              <Button onClick={() => close(() => state.resolve(promptValue))}>
                {state.opts.confirmLabel ?? 'OK'}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={state?.kind === 'alert'}
        onClose={() => state?.kind === 'alert' && close(() => state.resolve())}
        title={state?.kind === 'alert' ? state.opts.title : undefined}
        centered
        size="sm"
      >
        {state?.kind === 'alert' && (
          <Stack gap="md">
            <Text fz="sm">{state.opts.message}</Text>
            <Group justify="flex-end">
              <Button onClick={() => close(() => state.resolve())} autoFocus>
                {state.opts.closeLabel ?? 'OK'}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </DialogCtx.Provider>
  )
}
