/**
 * One request, open: what a person reads before answering, in the order they
 * need it — who asks and on which mission, the one statement of what is
 * asked, exactly what was sent, what it counts against, then the answers and
 * what an answer is worth.
 *
 * - `RequestStatement` — the line that says who asks, then the statement, at
 *   the size of a page title: the focal point of the page.
 * - `CallBox` + `ArgList` — "Exactly what it sent": the tool, and each
 *   argument by its name, in mono, as the protocol spells them. The one quiet
 *   fill of the page; never truncated, a long value wraps and scrolls.
 * - `FactColumns` — two or three labelled facts side by side (the permission
 *   it needs, the room left).
 * - `DecideBar` — the answer buttons, primary first, and at most one quieter
 *   alternative at the end of the line.
 * - `ContextColumns` — what led here and what the agent sees meanwhile, below
 *   the answers: context, never a condition to answer.
 * - `Feed` / `FeedEvent` — a short timeline: a time, a mark that carries its
 *   word, one sentence.
 *
 * No hook: these render in server and client components alike.
 */
import { cn } from '@/lib/utils';

import { Icon, type IconName } from './Icon.tsx';

export function RequestStatement({
  verb,
  children,
  status,
  testId,
}: {
  /** Who asks, with which key, on which mission: "codex using Carol’s key on Ship the billing page wants to". */
  verb: React.ReactNode;
  /** The statement: what is asked, in words; identifiers in `Code`. */
  children: React.ReactNode;
  /** The state of a request that is not open any more (a `StatusMark`), beside the statement. */
  status?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <p className="m-0 mb-1 text-small text-muted-foreground [&_b]:text-foreground [&_strong]:text-foreground">
        {verb}
      </p>
      <h2 className="m-0 flex flex-wrap items-center gap-x-3 gap-y-2 text-title leading-snug font-semibold tracking-(--tracking-title) [overflow-wrap:anywhere]">
        <span>{children}</span>
        {status && <span className="inline-flex tracking-normal">{status}</span>}
      </h2>
    </div>
  );
}

export function CallBox({
  label,
  aside,
  children,
  testId,
}: {
  /** What the box holds: "Exactly what it sent", "Stopped on". */
  label: React.ReactNode;
  /** On the right of the label: the tool, in mono. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="mt-[18px] rounded-lg bg-sidebar px-3.5 py-3" data-testid={testId}>
      <div className="mb-1.5 flex flex-wrap justify-between gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <span>{label}</span>
        {aside && <span className="min-w-0 [overflow-wrap:anywhere]">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

export interface ArgItem {
  readonly name: string;
  readonly value: React.ReactNode;
}

/** Each argument by its name. A value is printed whole: it wraps, and a long one scrolls. */
export function ArgList({ items, testId }: { items: readonly ArgItem[]; testId?: string }) {
  return (
    <dl
      className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-[3px] font-mono text-caption leading-[1.6] max-sm:grid-cols-1 max-sm:gap-0.5 [&_dd]:m-0 [&_dd]:max-h-[180px] [&_dd]:overflow-auto [&_dd]:whitespace-pre-wrap [&_dd]:text-foreground [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-muted-foreground max-sm:[&>div+div>dt]:mt-1.5"
      data-testid={testId}
    >
      {items.map((item) => (
        <div key={item.name} className="contents">
          <dt>{item.name}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface Fact {
  readonly label: React.ReactNode;
  readonly value: React.ReactNode;
  readonly testId?: string;
}

export function FactColumns({ items }: { items: readonly Fact[] }) {
  return (
    <dl className="m-0 mt-4 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3.5 text-small [&_dd]:m-0 [&_dd]:tabular-nums [&_dt]:mb-[3px] [&_dt]:text-caption [&_dt]:text-muted-foreground">
      {items.map((item, index) => (
        // A fixed, ordered set of facts: the index is its identity.
        <div key={index} data-testid={item.testId}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DecideBar({
  children,
  aside,
}: {
  /** The answers: the primary one first. */
  children: React.ReactNode;
  /** One quieter alternative, at the end of the line. */
  aside?: React.ReactNode;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2.5">
      {children}
      {aside && (
        <div className="ml-auto inline-flex items-center gap-2 text-small text-muted-foreground max-sm:ml-0">
          {aside}
        </div>
      )}
    </div>
  );
}

export function ContextColumns({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-8 grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-9 max-[1360px]:grid-cols-1 max-[1360px]:gap-7 [&>section>:first-child]:mt-0">
      {children}
    </div>
  );
}

export type FeedTone = 'neutral' | 'ok' | 'warn' | 'bad';

const FEED_ICON: Readonly<Record<FeedTone, IconName | null>> = {
  neutral: null,
  ok: 'check',
  warn: 'alert',
  bad: 'cross',
};

const FEED_MARK: Readonly<Record<FeedTone, string>> = {
  neutral: 'bg-muted text-muted-foreground',
  ok: 'bg-allowed-bg text-allowed-fg',
  warn: 'bg-approval-bg text-approval-fg',
  bad: 'bg-refused-bg text-refused-fg',
};

const FEED_WORD: Readonly<Record<FeedTone, string>> = {
  neutral: '',
  ok: 'Allowed: ',
  warn: 'Needs you: ',
  bad: 'Refused: ',
};

export function Feed({
  children,
  label,
  testId,
}: {
  children: React.ReactNode;
  label?: string;
  testId?: string;
}) {
  return (
    <ol className="m-0 list-none p-0 text-small" aria-label={label} data-testid={testId}>
      {children}
    </ol>
  );
}

export function FeedEvent({
  time,
  tone = 'neutral',
  children,
}: {
  /** When, short and rendered by the caller (a local time). */
  time: React.ReactNode;
  /** What kind of event: allowed, needs you, refused. Said in words to assistive technology. */
  tone?: FeedTone;
  children: React.ReactNode;
}) {
  const icon = FEED_ICON[tone];
  return (
    <li
      className="grid grid-cols-[52px_18px_minmax(0,1fr)] items-start gap-2.5 py-[5px]"
      data-tone={tone}
    >
      <span className="text-caption leading-[1.6] whitespace-nowrap tabular-nums text-muted-foreground">
        {time}
      </span>
      <span
        className={cn(
          'mt-px inline-grid size-[18px] place-items-center rounded-full',
          FEED_MARK[tone],
        )}
        aria-hidden="true"
      >
        {icon && <Icon name={icon} size={11} />}
      </span>
      <div className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
        {FEED_WORD[tone] && <span className="vbn-sr-only">{FEED_WORD[tone]}</span>}
        {children}
      </div>
    </li>
  );
}
