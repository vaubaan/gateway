import type { HTMLAttributes } from 'react';

import { cn } from './cn';

export type BadgeVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type BadgeSize = 'sm' | 'md';
export type BadgeShape = 'pill' | 'square';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly variant?: BadgeVariant;
  readonly size?: BadgeSize;
  readonly shape?: BadgeShape;
}

const VARIANT: Record<BadgeVariant, string> = {
  neutral: 'bg-sunken text-muted border border-border-default',
  info: 'bg-info text-info-foreground border border-info-border',
  success: 'bg-success text-success-foreground border border-success-border',
  warning: 'bg-warning text-warning-foreground border border-warning-border',
  danger: 'bg-danger text-danger-foreground border border-danger-border',
};

const SIZE: Record<BadgeSize, string> = {
  sm: 'text-[10px] px-1.5 py-0.5',
  md: 'text-xs px-2 py-0.5',
};

const SHAPE: Record<BadgeShape, string> = {
  pill: 'rounded-full',
  square: 'rounded-sm',
};

export function Badge({
  variant = 'neutral',
  size = 'md',
  shape = 'pill',
  className,
  ...rest
}: BadgeProps) {
  return (
    <span
      data-variant={variant}
      className={cn(
        'inline-flex items-center gap-1 font-medium leading-none',
        VARIANT[variant],
        SIZE[size],
        SHAPE[shape],
        className,
      )}
      {...rest}
    />
  );
}
