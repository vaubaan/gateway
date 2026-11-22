/**
 * The Trace symbol of the brand (`lib/brand.ts`), in
 * the ink of the theme (`currentColor`): one colour, never outlined, never on a
 * tile. No hook: it renders in server and client components alike.
 */
import { TRACE } from '@/lib/brand';

export { TRACE };

export function TraceMark({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d={TRACE} />
    </svg>
  );
}
