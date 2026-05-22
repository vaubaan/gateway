import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground border border-primary hover:opacity-90 active:opacity-100',
  secondary: 'bg-surface text-foreground border border-border-default hover:border-border-strong',
  ghost: 'bg-transparent text-foreground border border-transparent hover:bg-sunken',
  danger: 'bg-danger-foreground text-background border border-danger-foreground hover:opacity-90',
  link: 'bg-transparent text-foreground border border-transparent underline underline-offset-2 hover:text-muted px-0',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3 text-sm gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled ?? loading}
      data-loading={loading ? '' : undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
