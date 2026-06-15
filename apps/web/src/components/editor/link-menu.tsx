import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ActionIcon, Tooltip } from '@mantine/core'

export interface LinkMenuProps {
  /** The clicked link element the menu anchors to. */
  anchor: HTMLElement
  /** The link's (normalized) href, shown as the Open tooltip. */
  href: string
  onOpen: () => void
  onEdit: () => void
  onRemove: () => void
  onClose: () => void
}

/**
 * Compact click-anchored link toolbar for the editor's EDIT mode: three icon
 * buttons — open · edit · unlink. Replaces BlockNote's hover LinkToolbar (which
 * opens upward into the previous line and re-targets when the pointer crosses
 * another link, so it "doesn't stick" with stacked links). Click-triggered and
 * positioned BELOW the link, so it's deterministic regardless of layout.
 * Dismisses on outside-click / Escape / scroll. Portaled to <body> so the
 * editor's overflow never clips it.
 */
export function LinkMenu({ anchor, href, onOpen, onEdit, onRemove, onClose }: LinkMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const rect = anchor.getBoundingClientRect()

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const dismiss = () => onClose()
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [onClose])

  // Keep the bar on-screen for a link near the right edge.
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 120))
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        top: rect.bottom + 6,
        left,
        zIndex: 60,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 3,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)'
      }}
    >
      <Tooltip label={href} withArrow openDelay={250} maw={320} multiline>
        <ActionIcon variant="subtle" size="sm" onClick={onOpen} aria-label="Open link">
          <OpenIcon />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Edit link" withArrow openDelay={250}>
        <ActionIcon variant="subtle" size="sm" onClick={onEdit} aria-label="Edit link">
          <EditIcon />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Remove link" withArrow openDelay={250}>
        <ActionIcon variant="subtle" size="sm" color="red" onClick={onRemove} aria-label="Remove link">
          <UnlinkIcon />
        </ActionIcon>
      </Tooltip>
    </div>,
    document.body
  )
}

// ----- icons (inline stroke SVG, matching the repo's icon convention) -----

const svgProps = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

function OpenIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  )
}

function UnlinkIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="m5.17 11.75-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      <line x1="2" x2="5" y1="2" y2="5" />
      <line x1="19" x2="22" y1="19" y2="22" />
    </svg>
  )
}
