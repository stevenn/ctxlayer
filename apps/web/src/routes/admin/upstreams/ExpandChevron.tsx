/**
 * Small inline-SVG chevron. Points right when collapsed, rotates 90°
 * to point down when expanded. SVG keeps the icon crisp at any zoom
 * level and avoids the font-rendering oddities you get with `▸` /
 * `>`-style character chevrons.
 */
export function ExpandChevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 120ms ease',
        color: 'var(--text-muted)'
      }}
      aria-hidden="true"
    >
      <path
        d="M6 3.5 L10.5 8 L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
