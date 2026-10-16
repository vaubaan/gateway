/**
 * The button, and the same look on a link. One primary action per screen
 * (`variant="primary"`, the accent); at most two secondary ones beside it; the
 * rest are `ghost` or live behind "···". A destructive action is `danger`:
 * red words on the neutral surface, never a red fill.
 *
 * A control that navigates is a link (`ButtonLink`), a control that acts is a
 * button: the two share their styles and nothing else.
 */
import Link from 'next/link';
import { type AnchorHTMLAttributes, type ButtonHTMLAttributes, forwardRef } from 'react';

import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

function classesOf(
  variant: ButtonVariant,
  size: ButtonSize,
  extra: readonly (string | undefined | false)[],
): string {
  return [styles.btn, styles[`v_${variant}`], styles[`s_${size}`], ...extra]
    .filter(Boolean)
    .join(' ');
}

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
      className={classesOf(variant, size, [loading && styles.loading, className])}
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
  const classes = classesOf(variant, size, [className]);
  if (external) {
    return (
      <a href={href} className={classes} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} {...rest}>
      {children}
    </Link>
  );
}
