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
 * No hook: it renders in server and client components alike.
 */
import Link from 'next/link';

import styles from './Pick.module.css';

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
    <ul className={styles.grid} aria-label={label} data-testid={testId}>
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
  const classes = [styles.card, unavailable ? styles.unavailable : ''].join(' ');
  const body = (
    <>
      {lead && <span className={styles.lead}>{lead}</span>}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {description && <span className={styles.description}>{description}</span>}
      </span>
    </>
  );
  return (
    <li className={styles.item} data-testid={testId}>
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
