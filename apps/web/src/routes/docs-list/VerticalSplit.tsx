import { useEffect, useRef, useState, type ReactNode } from 'react'

// Min pixel height kept for either pane so the divider can't bury one of them.
const MIN_PX = 120
const HANDLE_PX = 11
// Keyboard nudge step (px).
const STEP_PX = 24

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

function loadListPx(key: string): number | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= MIN_PX ? n : null
  } catch {
    return null
  }
}

/**
 * A "list over detail" vertical split with a draggable horizontal divider.
 *
 * Default (auto) sizing: the top pane shrinks to its content height — capped
 * at `autoMaxPx` (~3 rows), beyond which it scrolls — and the bottom pane
 * fills the remaining space flush beneath it. So a folder with 1–2 docs shows
 * the preview right under the list with no dead whitespace, while a long list
 * caps and scrolls instead of crowding the preview.
 *
 * Dragging the divider (or ↑/↓ on it) switches to an explicit top height,
 * persisted to localStorage under `storageKey`. Double-click resets to auto.
 */
export function VerticalSplit({
  top,
  bottom,
  storageKey,
  // ≈3 doc rows (caption + header + ~3 rows); a 4th clips to hint scroll.
  autoMaxPx = 250
}: {
  top: ReactNode
  bottom: ReactNode
  storageKey: string
  autoMaxPx?: number
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const topRef = useRef<HTMLDivElement | null>(null)
  // null = auto (content-sized, capped). A number = user-set explicit height.
  const [listPx, setListPx] = useState<number | null>(() => loadListPx(storageKey))
  const [dragging, setDragging] = useState(false)

  const maxListPx = () => {
    const h = containerRef.current?.getBoundingClientRect().height ?? 0
    return Math.max(MIN_PX, h - HANDLE_PX - MIN_PX)
  }

  // While dragging, track the pointer on the window so the gesture survives
  // the cursor leaving the thin divider; suppress selection during the drag.
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.height <= 0) return
      setListPx(clamp(e.clientY - rect.top, MIN_PX, maxListPx()))
    }
    const onUp = () => setDragging(false)
    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging])

  // Persist once the gesture settles (and on keyboard nudges). Auto mode (null)
  // clears the stored value so it reverts to content-sizing next load.
  useEffect(() => {
    if (dragging) return
    try {
      if (listPx == null) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, String(Math.round(listPx)))
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [dragging, listPx, storageKey])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    // From auto mode, seed from the current rendered list height first.
    const base = listPx ?? topRef.current?.offsetHeight ?? MIN_PX
    const delta = e.key === 'ArrowUp' ? -STEP_PX : STEP_PX
    setListPx(clamp(base + delta, MIN_PX, maxListPx()))
  }

  const auto = listPx == null
  return (
    <div
      ref={containerRef}
      style={{
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        display: 'grid',
        // Auto: top track is content-sized but capped at autoMaxPx (≈3 rows),
        // so a short list sits flush above the preview and a long one scrolls.
        // The 1fr preview track absorbs all remaining height either way.
        gridTemplateRows: auto
          ? `minmax(0, ${autoMaxPx}px) ${HANDLE_PX}px minmax(0, 1fr)`
          : `${listPx}px ${HANDLE_PX}px minmax(0, 1fr)`
      }}
    >
      <div ref={topRef} style={{ minHeight: 0, overflow: 'auto' }}>
        {top}
      </div>
      {/* <hr> carries the implicit ARIA `separator` role; focusable + value
          attrs make it the WAI-ARIA window-splitter widget. The grip bar is a
          centred background image (a void <hr> can host no children). */}
      <hr
        aria-orientation="horizontal"
        aria-label="Resize document list and preview"
        aria-valuenow={listPx == null ? undefined : Math.round(listPx)}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDoubleClick={() => setListPx(null)}
        onKeyDown={onKeyDown}
        style={{
          border: 'none',
          margin: 0,
          height: HANDLE_PX,
          cursor: 'row-resize',
          touchAction: 'none',
          background: 'transparent',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
          backgroundSize: '40px 4px',
          backgroundImage: `linear-gradient(${dragging ? 'var(--accent)' : 'var(--border)'}, ${dragging ? 'var(--accent)' : 'var(--border)'})`,
          borderRadius: 2
        }}
      />
      {bottom}
    </div>
  )
}
