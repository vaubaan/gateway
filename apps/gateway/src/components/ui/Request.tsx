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
import { Icon, type IconName } from './Icon.tsx';
import styles from './Request.module.css';

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
      <p className={styles.verb}>{verb}</p>
      <h2 className={styles.statement}>
        <span>{children}</span>
        {status && <span className={styles.status}>{status}</span>}
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
    <div className={styles.call} data-testid={testId}>
      <div className={styles.callHead}>
        <span>{label}</span>
        {aside && <span className={styles.callAside}>{aside}</span>}
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
    <dl className={styles.args} data-testid={testId}>
      {items.map((item) => (
        <div key={item.name} className={styles.arg}>
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
    <dl className={styles.facts}>
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
    <div className={styles.decide}>
      {children}
      {aside && <div className={styles.decideAside}>{aside}</div>}
    </div>
  );
}

export function ContextColumns({ children }: { children: React.ReactNode }) {
  return <div className={styles.context}>{children}</div>;
}

export type FeedTone = 'neutral' | 'ok' | 'warn' | 'bad';

const FEED_ICON: Readonly<Record<FeedTone, IconName | null>> = {
  neutral: null,
  ok: 'check',
  warn: 'alert',
  bad: 'cross',
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
    <ol className={styles.feed} aria-label={label} data-testid={testId}>
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
    <li className={styles.event}>
      <span className={styles.time}>{time}</span>
      <span className={[styles.mark, styles[`mark_${tone}`]].join(' ')} aria-hidden="true">
        {icon && <Icon name={icon} size={11} />}
      </span>
      <div className={styles.eventText}>
        {FEED_WORD[tone] && <span className="vbn-sr-only">{FEED_WORD[tone]}</span>}
        {children}
      </div>
    </li>
  );
}
