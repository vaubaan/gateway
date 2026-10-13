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

import styles from './Running.module.css';

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
    <ul className={styles.list} aria-label={label} data-testid={testId}>
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
    <li className={styles.row} data-testid={testId}>
      <div className={styles.text}>
        <div className={styles.title}>
          <Link href={href} className={styles.titleLink}>
            {title}
          </Link>
        </div>
        {facts && <div className={styles.facts}>{facts}</div>}
        {detail}
      </div>
      <div className={styles.holders}>{holders}</div>
      <div className={styles.figure}>{figure}</div>
      <div className={styles.last}>{last}</div>
    </li>
  );
}
