/**
 * The ctxlayer "layers" logo mark, shared by the sidebar brand and the
 * sign-in card. Same SVG as the marketing site (ctxlayer.net) so the app
 * and the landing page stay visually identical. Uses `currentColor`, so
 * callers set the colour via CSS (`.brand-mark` → `var(--brand)`).
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  )
}
