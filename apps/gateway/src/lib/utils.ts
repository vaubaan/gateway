/**
 * shadcn/ui's class helper: joins class names and lets a later Tailwind
 * utility override an earlier one of the same property. The site has the same
 * (`apps/website/src/lib/utils.ts`).
 *
 * The shared theme names its sizes (`text-caption`, `text-small`, `text-body`,
 * `text-title`, the site's `text-display`); tailwind-merge is told they are
 * font sizes, or it would take `text-caption` for a colour and drop it beside
 * `text-foreground`.
 */
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** The sizes of `@vaubaan/design-tokens/theme.css` (`--text-*`). */
export const TEXT_SIZES = ['caption', 'small', 'body', 'title', 'display'] as const;

const twMerge = extendTailwindMerge({
  extend: { theme: { text: [...TEXT_SIZES] } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
