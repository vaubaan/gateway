/**
 * A bordered box. A border, a fill and a shadow are each a claim that
 * something is a separate object, so a page uses a card **once at most**: the
 * rail that summarises what is being created, the one thing set apart. Lists
 * are `Rows` or a `DataTable`, never cards; a region is a `Section`.
 *
 * shadcn/ui's Card, copied and owned on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site); no shadow, the
 * card sits in the page flow.
 */
import { type HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card"
      className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5',
        className,
      )}
      {...rest}
    />
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="m-0 text-small font-semibold">{children}</h3>;
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="card-content" className={cn('p-3.5', className)} {...rest} />;
}

/** The foot of the rail: the one primary action of the page, and a quiet hint. */
export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        'flex items-center gap-2 border-t border-border bg-sidebar px-3.5 py-3',
        className,
      )}
      {...rest}
    />
  );
}
