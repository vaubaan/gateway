import type { HTMLAttributes } from 'react';

import { cn } from './cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-md border border-border-default bg-surface text-surface-foreground',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-1 border-b border-border-default px-4 py-3', className)}
      {...rest}
    />
  );
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-base font-semibold tracking-tight', className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-muted', className)} {...rest} />;
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-3', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border-default px-4 py-3',
        className,
      )}
      {...rest}
    />
  );
}
