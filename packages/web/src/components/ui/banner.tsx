import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from './cn';

export type BannerVariant = 'info' | 'warning' | 'danger' | 'success';

export interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  readonly variant?: BannerVariant;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  readonly onDismiss?: () => void;
}

const VARIANT: Record<BannerVariant, string> = {
  info: 'bg-info text-info-foreground border-info-border',
  warning: 'bg-warning text-warning-foreground border-warning-border',
  danger: 'bg-danger text-danger-foreground border-danger-border',
  success: 'bg-success text-success-foreground border-success-border',
};

export function Banner({
  variant = 'info',
  icon,
  action,
  onDismiss,
  className,
  children,
  ...rest
}: BannerProps) {
  return (
    <div
      role={variant === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-center gap-3 border-b px-4 py-2.5 text-sm',
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-sm px-1 text-current opacity-70 hover:opacity-100"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
