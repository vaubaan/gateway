/**
 * shadcn/ui's Button, copied and owned (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site): the variants of the
 * style guide §5 — primary, secondary, ghost, danger (red words, never a red
 * fill), link. The site's buttons navigate, so they are links styled with
 * `buttonVariants()`; no script, no Radix Slot.
 *
 * Imports are relative: the unit tests render these without the site's alias.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-ink',
        secondary:
          'border border-border-strong bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        danger: 'border border-border-strong bg-secondary text-destructive hover:bg-accent',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 text-sm',
        md: 'h-8 px-3 text-sm',
        lg: 'h-10 px-4 text-[0.9375rem]',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<'button'> & ButtonVariants) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
