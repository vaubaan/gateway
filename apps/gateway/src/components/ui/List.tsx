/**
 * The quiet list: rows separated by hairlines, no card around them, no icon
 * unless it is a mark of who or what. A row is a title, one line of facts
 * under it, and — at its end — what one can do or the one figure that matters.
 *
 * `Rows` is the list (a `<ul>`), `Row` one entry. Use it for a handful of
 * objects of the same kind; use `DataTable` when columns are compared.
 */
import Link from 'next/link';

import { cn } from '@/lib/utils';

export function Rows({
  children,
  label,
  testId,
}: {
  children: React.ReactNode;
  /** Names the list when no heading does. */
  label?: string;
  testId?: string;
}) {
  return (
    <ul
      className="m-0 list-none border-t border-border p-0"
      aria-label={label}
      data-testid={testId}
    >
      {children}
    </ul>
  );
}

export function Row({
  lead,
  title,
  href,
  description,
  aside,
  end,
  muted = false,
  testId,
}: {
  /** A mark before the text: an avatar, a service mark, a step number, a check. */
  lead?: React.ReactNode;
  title: React.ReactNode;
  /** Makes the title a link to the object. */
  href?: string;
  /** One line of facts, in the quiet ink. */
  description?: React.ReactNode;
  /** Between the text and the end: avatars, a meter, a status — at most one thing. */
  aside?: React.ReactNode;
  /** The end of the row: an action, or a short fact such as a time. */
  end?: React.ReactNode;
  /** A row that is not live any more (expired, stopped). */
  muted?: boolean;
  testId?: string;
}) {
  return (
    <li
      className="flex items-center gap-3.5 border-b border-border py-(--row-y) text-body max-[720px]:flex-wrap"
      data-muted={muted || undefined}
      data-testid={testId}
    >
      {lead && <span className="inline-flex flex-none">{lead}</span>}
      <div className="min-w-0 flex-1">
        <div className={muted ? 'font-normal text-muted-foreground' : 'font-semibold'}>
          {href ? (
            <Link href={href} className="hover:underline">
              {title}
            </Link>
          ) : (
            title
          )}
        </div>
        {description && (
          <div className="mt-px font-normal text-muted-foreground [&_a]:text-primary">
            {description}
          </div>
        )}
      </div>
      {aside && (
        <div className="flex flex-none items-center gap-3 max-[720px]:order-3 max-[720px]:basis-full">
          {aside}
        </div>
      )}
      {end && (
        <div
          className={cn(
            'ml-auto flex flex-none items-center gap-2 tabular-nums text-muted-foreground',
          )}
        >
          {end}
        </div>
      )}
    </li>
  );
}
