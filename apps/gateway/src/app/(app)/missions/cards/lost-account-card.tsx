'use client';

/**
 * The card of an account that no longer serves a mission (ADR
 * orphaned-missions-and-ownerless-connections, amendment 2026-11-16): red, folded to
 * one line that says which account and why its calls are refused; unfolding it shows
 * the rest of the explanation and what the account held on the mission (its cards,
 * frozen). The mission page draws it in place of that account's cards; "Edit mission"
 * draws it with "Remove from mission". Nothing removes or hides it but that edit.
 */
import { Disclosure, ServiceMark, type ServiceMarkIcon } from '@/components/ui';
import { LOST_ACCOUNT_WORDS } from '@/lib/vocabulary';

import styles from './cards.styles';

export interface LostAccountView {
  readonly account_id: string;
  readonly service_label: string;
  /** `null` when the account no longer exists. */
  readonly display_name: string | null;
  /** One line (`explainLostAccount().summary`). */
  readonly summary: string;
  /** What unfolding adds (`explainLostAccount().lines`). */
  readonly lines: readonly string[];
}

export function LostAccountCard({
  lost,
  icon,
  action = null,
  removing = false,
  children = null,
}: {
  lost: LostAccountView;
  icon: ServiceMarkIcon | null;
  /** "Remove from mission" / "Keep it", in Edit mission; nothing on the mission page. */
  action?: React.ReactNode;
  /** Edit mission: removed when the edit is saved. */
  removing?: boolean;
  /** What the account held on the mission: its cards, frozen. */
  children?: React.ReactNode;
}) {
  const label =
    lost.display_name === null
      ? lost.service_label
      : `${lost.service_label} · ${lost.display_name}`;
  return (
    <section
      className={[styles.lostCard, removing && styles.lostRemoving].filter(Boolean).join(' ')}
      aria-label={label}
      data-testid={`lost-account-${lost.account_id}`}
      data-removing={removing || undefined}
    >
      <div className={styles.lostHead}>
        <ServiceMark name={lost.service_label} icon={icon} />
        <span className={styles.account}>{label}</span>
        {action && <span className={styles.headEnd}>{action}</span>}
      </div>
      <p className={styles.lostLine} data-testid="lost-account-summary">
        {removing ? LOST_ACCOUNT_WORDS.removedOnSave : lost.summary}
      </p>
      <div className={styles.lostBody}>
        <Disclosure
          id={`lost-account:${lost.account_id}`}
          remember={false}
          show={LOST_ACCOUNT_WORDS.showDetails}
          hide={LOST_ACCOUNT_WORDS.hideDetails}
          testId="lost-account-details"
        >
          <div className={styles.lostDetails}>
            {removing && <p>{lost.summary}</p>}
            {lost.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          {children && <div className={styles.cards}>{children}</div>}
        </Disclosure>
      </div>
    </section>
  );
}
