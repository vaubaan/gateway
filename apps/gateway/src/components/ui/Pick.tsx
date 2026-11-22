/**
 * A choice among a handful of things of the same kind, each leading
 * somewhere: the services an account can be connected to. Drawn as a grid of
 * quiet bordered cards — a mark, a name, one line that says how.
 *
 * The exception to "rows, not cards": the cards ARE the action of the region
 * (one click each), there are few of them, and none holds data. An option
 * that cannot be taken yet is dashed, says why, and leads to where it is
 * fixed when the person can fix it.
 *
 * No hook: it renders in server and client components alike. Tailwind on the
 * shared tokens.
 */
import Link from 'next/link';

import { cn } from '@/lib/utils';

export function PickGrid({
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
      className="m-0 grid max-w-[760px] list-none grid-cols-3 gap-2.5 p-0 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1"
      aria-label={label}
      data-testid={testId}
    >
      {children}
    </ul>
  );
}

export function PickCard({
  href,
  lead,
  title,
  description,
  unavailable = false,
  testId,
}: {
  /** Where the choice leads. Without it the card is a plain statement. */
  href?: string;
  /** A mark before the text (a `ServiceMark`). */
  lead?: React.ReactNode;
  title: React.ReactNode;
  /** One line: how, or why not. */
  description?: React.ReactNode;
  /** Cannot be taken now: dashed, quiet; the description says why. */
  unavailable?: boolean;
  testId?: string;
}) {
  const classes = cn(
    'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-border px-3.5 py-3 text-small text-foreground transition-colors',
    href && 'hover:border-muted-foreground hover:no-underline',
    unavailable && 'border-dashed text-muted-foreground',
  );
  const body = (
    <>
      {lead && <span className="inline-flex flex-none">{lead}</span>}
      <span className="flex min-w-0 flex-col">
        <span className="[overflow-wrap:anywhere]">{title}</span>
        {description && <span className="text-caption text-muted-foreground">{description}</span>}
      </span>
    </>
  );
  return (
    <li className="flex" data-testid={testId}>
      {href ? (
        <Link href={href} className={classes}>
          {body}
        </Link>
      ) : (
        <span className={classes}>{body}</span>
      )}
    </li>
  );
}
