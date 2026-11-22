/**
 * The inbox: one list, one item open beside it. A person reads down the list
 * and answers on the right without leaving the page; on a narrow window the
 * list sits above the item.
 *
 * - `InboxFrame` — the two columns: the list, then the open item.
 * - `InboxList` / `InboxItem` — what waits: who asks (a mark), what, on which
 *   mission, how long ago. The open item is filled, not coloured, and carries
 *   `aria-current`.
 *
 * The list is navigation: each item is a link to its own address, so the
 * forwarded link of a request and the list lead to the same place.
 */
import Link from 'next/link';

import { cn } from '@/lib/utils';

export function InboxFrame({
  list,
  children,
}: {
  list: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-10 max-[1360px]:grid-cols-[250px_minmax(0,1fr)] max-[1360px]:gap-7 max-[900px]:grid-cols-1 max-[900px]:gap-6">
      <div className="min-w-0">{list}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function InboxList({
  label,
  children,
  footer,
  testId,
}: {
  /** Names the list for assistive technology ("Waiting for you"). */
  label: string;
  children: React.ReactNode;
  /** A quiet line under the list: what was answered already. */
  footer?: React.ReactNode;
  testId?: string;
}) {
  return (
    <nav aria-label={label} data-testid={testId}>
      <ul className="m-0 list-none p-0">{children}</ul>
      {footer && <p className="m-0 px-2.5 py-3 text-small text-muted-foreground">{footer}</p>}
    </nav>
  );
}

export function InboxItem({
  href,
  current = false,
  who,
  title,
  context,
  meta,
  testId,
}: {
  href: string;
  /** The item open beside the list. */
  current?: boolean;
  /** The mark of who asks: an `Avatar` (a person or a machine key). */
  who: React.ReactNode;
  /** What is asked, short. */
  title: React.ReactNode;
  /** The mission, then who and with what. */
  context?: React.ReactNode;
  /** How long ago, and when it ends by itself. */
  meta?: React.ReactNode;
  testId?: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className={cn(
          'grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 border-b border-border px-2.5 py-3 text-small hover:bg-accent hover:no-underline',
          // The open item: a fill, not a colour.
          current && 'rounded-md border-b-transparent bg-muted hover:bg-muted',
        )}
        aria-current={current ? 'page' : undefined}
        data-testid={testId}
      >
        <span className="mt-px inline-flex">{who}</span>
        <span className="grid min-w-0 gap-0.5">
          <span className="leading-[1.35] font-semibold [overflow-wrap:anywhere]">{title}</span>
          {context && (
            <span className="text-muted-foreground [overflow-wrap:anywhere]">{context}</span>
          )}
          {meta && <span className="text-caption text-muted-foreground">{meta}</span>}
        </span>
      </Link>
    </li>
  );
}
