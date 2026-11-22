/**
 * The button, and the same look on a link. One primary action per screen
 * (`variant="primary"`, the accent); at most two secondary ones beside it; the
 * rest are `ghost` or live behind "···". A destructive action is `danger`:
 * red words on the neutral surface, never a red fill.
 *
 * A control that navigates is a link (`ButtonLink`), a control that acts is a
 * button: the two share their styles (`buttonVariants`) and nothing else.
 *
 * shadcn/ui's Button, copied and owned (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site), with the variants
 * of the style guide §5; the site's `components/ui/button.tsx` draws the same.
 */
import { cva } from 'class-variance-authority';
import Link from 'next/link';
import { type AnchorHTMLAttributes, type ButtonHTMLAttributes, forwardRef } from 'react';

import { cn } from '@/lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * 26 and 30 px to the eye, 32 px to the pointer (style guide §6): the small
 * and medium sizes reach further than they draw, through `::after`.
 */
export const buttonVariants = cva(
  'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-body leading-none font-normal no-underline transition-colors hover:no-underline focus-visible:rounded-md disabled:cursor-not-allowed disabled:text-faint aria-busy:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'border-primary bg-primary text-primary-foreground hover:enabled:border-primary-ink hover:enabled:bg-primary-ink [&:is(a):hover]:border-primary-ink [&:is(a):hover]:bg-primary-ink disabled:border-border disabled:bg-muted',
        secondary:
          'border-border-strong bg-card text-foreground hover:enabled:bg-accent [&:is(a):hover]:bg-accent',
        ghost:
          'border-transparent bg-transparent text-muted-foreground hover:enabled:bg-accent hover:enabled:text-accent-foreground [&:is(a):hover]:bg-accent',
        danger:
          'border-border-strong bg-card text-destructive hover:enabled:border-refused-border hover:enabled:bg-refused-bg [&:is(a):hover]:bg-refused-bg',
      },
      size: {
        sm: "h-7 px-2 after:absolute after:inset-x-0 after:-inset-y-[3px] after:content-['']",
        md: "h-8 px-3 after:absolute after:inset-x-0 after:-inset-y-[3px] after:content-['']",
        lg: 'h-9 px-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The action is under way: the button is disabled and says so to assistive technology. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, className, children, ...rest }: ButtonProps,
  ref,
) {
  return (
    <button
      ref={ref}
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={rest.disabled ?? loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {children}
    </button>
  );
});

export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A plain `<a>` (another origin, a download, a fragment handled by the page). */
  external?: boolean;
}

export function ButtonLink({
  href,
  variant = 'secondary',
  size = 'md',
  external = false,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (external) {
    return (
      <a href={href} className={classes} data-slot="button" data-variant={variant} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} data-slot="button" data-variant={variant} {...rest}>
      {children}
    </Link>
  );
}
