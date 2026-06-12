import type { KeyboardEvent } from 'react'

/**
 * Props for a clickable table row (or other non-button container) so it
 * is keyboard-operable: Tab reaches it, Enter/Space activate it. Spread
 * onto the element: `<tr {...clickableRow(() => open(id))}>`.
 *
 * - `className="row-clickable"` opts the row into the pointer cursor
 *   (see `.data-table tbody tr.row-clickable` in index.css).
 * - The keydown guard ignores events bubbling up from nested interactive
 *   children (menu triggers, buttons), so pressing Enter on an inner
 *   control doesn't also activate the row.
 * - Space is preventDefault'ed so it doesn't scroll the page.
 */
export function clickableRow(onOpen: () => void) {
  return {
    className: 'row-clickable',
    tabIndex: 0,
    role: 'button' as const,
    onClick: onOpen,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      onOpen()
    }
  }
}
