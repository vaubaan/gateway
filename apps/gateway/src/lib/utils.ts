/**
 * shadcn/ui's class helper: joins class names and lets a later Tailwind
 * utility override an earlier one of the same property.
 *
 * The shared theme names its four sizes (`text-caption`, `text-secondary`,
 * `text-body`, `text-title`, and the site's `text-display`); tailwind-merge is
 * told they are font sizes, or it would take `text-caption` for a colour and
 * drop it beside `text-muted-foreground`.
 */
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['caption', 'secondary', 'body', 'title', 'display'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
