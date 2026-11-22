/**
 * The pager of an Activity tab: which lines are shown, then Newest, Newer and
 * Older. Plain links, so it works without JavaScript; a direction with no page
 * is drawn but not a link, so the pager does not move under the pointer.
 */
import Link from 'next/link';

import { ACTIVITY_WORDS } from '@/lib/vocabulary';

import styles from './activity.styles';

export function Pager({
  lines,
  newest,
  newer,
  older,
}: {
  /** "Lines 51–100". */
  lines: string;
  newest: string | null;
  newer: string | null;
  older: string | null;
}) {
  const step = (href: string | null, label: string, testId: string, rel?: 'prev' | 'next') =>
    href ? (
      <Link href={href} scroll={false} rel={rel} className={styles.pagerLink} data-testid={testId}>
        {label}
      </Link>
    ) : (
      <span className={styles.pagerOff} aria-disabled="true" data-testid={testId}>
        {label}
      </span>
    );
  return (
    <nav className={styles.pager} aria-label="Pages" data-testid="pager">
      <span className={styles.pagerLines} data-testid="lines-shown">
        {lines}
      </span>
      <span className={styles.pagerSteps}>
        {newest && (
          <Link
            href={newest}
            scroll={false}
            className={styles.pagerLink}
            data-testid="pager-newest"
          >
            {ACTIVITY_WORDS.newest}
          </Link>
        )}
        {step(newer, ACTIVITY_WORDS.newer, 'pager-newer', 'prev')}
        {step(older, ACTIVITY_WORDS.older, 'pager-older', 'next')}
      </span>
    </nav>
  );
}
