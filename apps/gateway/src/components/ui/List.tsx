/**
 * The quiet list: rows separated by hairlines, no card around them, no icon
 * unless it is a mark of who or what. A row is a title, one line of facts
 * under it, and — at its end — what one can do or the one figure that matters.
 *
 * `Rows` is the list (a `<ul>`), `Row` one entry. Use it for a handful of
 * objects of the same kind; use `DataTable` when columns are compared.
 */
import Link from 'next/link';

import styles from './List.module.css';

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
    <ul className={styles.rows} aria-label={label} data-testid={testId}>
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
    <li className={[styles.row, muted ? styles.muted : ''].join(' ')} data-testid={testId}>
      {lead && <span className={styles.lead}>{lead}</span>}
      <div className={styles.grow}>
        <div className={styles.title}>
          {href ? (
            <Link href={href} className={styles.titleLink}>
              {title}
            </Link>
          ) : (
            title
          )}
        </div>
        {description && <div className={styles.description}>{description}</div>}
      </div>
      {aside && <div className={styles.aside}>{aside}</div>}
      {end && <div className={styles.end}>{end}</div>}
    </li>
  );
}
