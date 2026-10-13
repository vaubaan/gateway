/**
 * What a mission allows, in three lines a person reads before anything else:
 * **Can · Asks you first · Cannot**, and — when one limit is near — a fourth,
 * "Limits today". The first thing on a mission page and the content of the
 * rail while one is created.
 *
 * It is a summary of an explicit list, never a replacement for it: the count
 * of permissions is said, and the list is one click away.
 *
 * `AllowSummary` is the wide form (a definition list, capped at the prose
 * measure); `compact` is the form of the rail (narrower labels, smaller text).
 */
import { ALLOW_WORDS } from '@/lib/vocabulary';

import styles from './Allow.module.css';

export function AllowSummary({
  can,
  asks,
  cannot,
  limits,
  asksLabel = ALLOW_WORDS.asks,
  compact = false,
  testId,
}: {
  /** What runs freely, as a sentence. */
  can: React.ReactNode;
  /** What asks first; `null` when nothing does (the line is then left out). */
  asks?: React.ReactNode;
  /** What is not in the mission and is therefore refused. */
  cannot: React.ReactNode;
  /** The one limit near its end today (a `Meter` and a few words). */
  limits?: React.ReactNode;
  /** "Asks you first", or "Asks Alice first" on someone else's mission (`asksFirst`). */
  asksLabel?: string;
  compact?: boolean;
  testId?: string;
}) {
  return (
    <dl className={[styles.allow, compact ? styles.compact : ''].join(' ')} data-testid={testId}>
      <div className={styles.line}>
        <dt>{ALLOW_WORDS.can}</dt>
        <dd>{can}</dd>
      </div>
      {asks && (
        <div className={[styles.line, styles.asks].join(' ')}>
          <dt>{asksLabel}</dt>
          <dd>{asks}</dd>
        </div>
      )}
      <div className={[styles.line, styles.quiet].join(' ')}>
        <dt>{ALLOW_WORDS.cannot}</dt>
        <dd>{cannot}</dd>
      </div>
      {limits && (
        <div className={[styles.line, styles.quiet].join(' ')}>
          <dt>{ALLOW_WORDS.limits}</dt>
          <dd>{limits}</dd>
        </div>
      )}
    </dl>
  );
}
