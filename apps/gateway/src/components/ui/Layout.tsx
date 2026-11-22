/**
 * A page outside the application shell (sign-in, the bootstrap page) sits in
 * a `Container`: the page measure, centred, with the page's padding. Inside
 * the shell the page column is the shell's (`components/shell`). `Stack`
 * piles its children with one of the spacing steps.
 */
import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export function Container({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        'mx-auto max-w-(--page-max) px-(--page-pad-x) pt-(--page-pad-top) pb-(--page-pad-bottom)',
        className,
      )}
    >
      {children}
    </div>
  );
}

const GAP = { 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4', 6: 'gap-6' } as const;

export function Stack({
  gap = 3,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { gap?: keyof typeof GAP }) {
  return (
    <div {...rest} className={cn('flex flex-col', GAP[gap], className)}>
      {children}
    </div>
  );
}
