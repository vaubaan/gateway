/**
 * The Trace mark of the site's header and footer (brand: one bastion drawn in
 * plan, its salient the V). Imports nothing: the unit tests render it.
 */
/** The Trace symbol: one bastion drawn in plan, its salient the V (64 × 64 grid). */
export const TRACE =
  'M2 17 L11 17 L11 24.23 L32 55.11 L53 24.23 L53 17 L62 17 L62 9 L45 9 L45 21.77 L32 40.89 L19 21.77 L19 9 L2 9Z';

/**
 * The lockup — the symbol and the drawn wordmark — in the ink of the theme
 * (`currentColor`): one colour, never outlined, never on a tile.
 */
export function Lockup({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 265 64"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d={TRACE} />
      <g transform="translate(80 20.8) scale(0.7)" stroke="currentColor" strokeWidth="6.5">
        <path d="M0 0H7L15 23.2L23 0H30L18.6 32H11.4Z" stroke="none" />
        <circle cx="52" cy="16" r="12.75" fill="none" />
        <path d="M61.50 4.55L68.00 0.00V32H61.50Z" stroke="none" />
        <path d="M78.25 4.55V16A12.75 12.75 0 0 0 103.75 16" fill="none" />
        <path d="M75.00 4.55L81.50 0.00V16.5H75.00Z" stroke="none" />
        <path d="M100.50 4.55L107.00 0.00V32H100.50Z" stroke="none" />
        <path d="M114.00 -14.45L120.50 -19.00V32H114.00Z" stroke="none" />
        <circle cx="130" cy="16" r="12.75" fill="none" />
        <circle cx="168.5" cy="16" r="12.75" fill="none" />
        <path d="M178.00 4.55L184.50 0.00V32H178.00Z" stroke="none" />
        <circle cx="207" cy="16" r="12.75" fill="none" />
        <path d="M216.50 4.55L223.00 0.00V32H216.50Z" stroke="none" />
        <path d="M230.00 4.55L236.50 0.00V32H230.00Z" stroke="none" />
        <path d="M233.25 16A12.75 12.75 0 0 1 258.75 16V32" fill="none" />
      </g>
    </svg>
  );
}
