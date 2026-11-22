/**
 * What is running, one line per mission: its name and where it works, who
 * holds a key, **the one figure that matters** and when it last did
 * something. The four are columns, so that a list of missions reads down as
 * well as across; hairlines between the lines, no card.
 *
 * - `RunList` / `RunRow` — the list of "Running now" on the home.
 *
 * `figure` is at most one thing: a `Meter` (which draws itself only near a
 * limit and is a dash otherwise) or a `StatusMark` for the exception. A line
 * never carries a bar that says "all is well". `detail` is a second line shown
 * only while the surrounding `DetailScope` is open.
 */
import Link from 'next/link';

export function RunList({
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

export function RunRow({
  title,
  href,
  facts,
  holders,
  figure,
  last,
  detail,
  testId,
}: {
  title: React.ReactNode;
  /** The mission's page. */
  href: string;
  /** Where it works and who works on it, in the quiet ink. */
  facts?: React.ReactNode;
  /** The marks of who holds a key (an `AvatarStack`). */
  holders?: React.ReactNode;
  /** A `Meter`, or a `StatusMark` for the exception. */
  figure?: React.ReactNode;
  /** When it last did something, short ("2 min"). */
  last?: React.ReactNode;
  /** More facts, shown while the surrounding `DetailScope` is open (a `DetailOnly`). */
  detail?: React.ReactNode;
  testId?: string;
}) {
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_84px_210px_70px] items-center gap-3 border-b border-border py-2.5 text-small max-[860px]:grid-cols-[minmax(0,1fr)_auto]"
      data-testid={testId}
    >
      <div className="min-w-0">
        <div className="font-semibold [overflow-wrap:anywhere]">
          <Link href={href} className="hover:underline">
            {title}
          </Link>
        </div>
        {facts && (
          <div className="mt-px text-caption text-muted-foreground [overflow-wrap:anywhere]">
            {facts}
          </div>
        )}
        {detail}
      </div>
      <div className="flex items-center pl-1.5 max-[860px]:hidden">{holders}</div>
      <div className="flex min-w-0 items-center text-muted-foreground max-[860px]:col-start-1">
        {figure}
      </div>
      <div className="text-right whitespace-nowrap tabular-nums text-muted-foreground max-[860px]:col-start-2 max-[860px]:row-start-1">
        {last}
      </div>
    </li>
  );
}
