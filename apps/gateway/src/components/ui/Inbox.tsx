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

import styles from './Inbox.module.css';

export function InboxFrame({
  list,
  children,
}: {
  list: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.frame}>
      <div className={styles.side}>{list}</div>
      <div className={styles.main}>{children}</div>
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
      <ul className={styles.list}>{children}</ul>
      {footer && <p className={styles.footer}>{footer}</p>}
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
        className={[styles.item, current ? styles.current : ''].join(' ')}
        aria-current={current ? 'page' : undefined}
        data-testid={testId}
      >
        <span className={styles.who}>{who}</span>
        <span className={styles.text}>
          <span className={styles.title}>{title}</span>
          {context && <span className={styles.context}>{context}</span>}
          {meta && <span className={styles.meta}>{meta}</span>}
        </span>
      </Link>
    </li>
  );
}
