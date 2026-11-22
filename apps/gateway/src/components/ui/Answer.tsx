/**
 * Something waits for the person, answerable where they see it: who asks,
 * what exactly, on which mission, how long ago — then the answer buttons, on
 * the same row.
 *
 * - `AnswerList` / `AnswerRow` — the list of "Waiting for you" (the home, the
 *   inbox). Rows and hairlines.
 * - `AnswerRow` with `boxed` — the same row as the one filled box of a page:
 *   the banner at the top of a mission that waits for its creator. The
 *   approval surface (the accent family), used **once per page at most**.
 *
 * The answers are the caller's (`answers`): `Approve` is the page's primary
 * action when something waits, `Refuse` a secondary one, `Details` a ghost.
 * For a limit that was reached the answer is `Raise`.
 */
import { cn } from '@/lib/utils';

export function AnswerList({
  children,
  label,
  testId,
}: {
  children: React.ReactNode;
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

export function AnswerRow({
  who,
  title,
  age,
  description,
  answers,
  boxed = false,
  testId,
}: {
  /** The mark of who asks: an `Avatar` at `size="md"` (a person or a machine key). */
  who: React.ReactNode;
  /** What is asked, as a sentence: "Merge pull request #418 into main on acme/web". */
  title: React.ReactNode;
  /** How long ago, short ("4 min"). */
  age?: React.ReactNode;
  /** Who and where, then why it is asked, then the room left. */
  description?: React.ReactNode;
  /** The answer buttons: primary first. */
  answers?: React.ReactNode;
  /** The filled form, in the accent family: the one thing on the page that waits for the person. */
  boxed?: boolean;
  testId?: string;
}) {
  const Tag = boxed ? 'div' : 'li';
  return (
    <Tag
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 text-small max-[720px]:grid-cols-[auto_minmax(0,1fr)]',
        boxed
          ? // The one filled box of a page: this mission waits for you.
            'rounded-lg border border-approval-border bg-approval-bg px-3.5 py-3'
          : 'border-b border-border py-3.5',
      )}
      role={boxed ? 'status' : undefined}
      data-testid={testId}
    >
      <span className="inline-flex">{who}</span>
      <div>
        <div className={cn('font-semibold', boxed ? 'text-small' : 'text-body')}>
          {title}
          {age && (
            <span className="ml-1.5 text-caption font-normal whitespace-nowrap text-muted-foreground">
              {age}
            </span>
          )}
        </div>
        {description && <div className="mt-0.5 text-muted-foreground">{description}</div>}
      </div>
      {answers && (
        <div className="flex items-center gap-1.5 pt-0.5 max-[720px]:col-start-2 max-[720px]:flex-wrap">
          {answers}
        </div>
      )}
    </Tag>
  );
}
