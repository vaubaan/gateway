/**
 * A note that interrupts on purpose: an optional short title, a sentence or
 * two. Tinted by its tone, and used sparingly — a filled box is a claim that
 * something is a separate object, so a page holds **one at most** for the
 * thing that needs the person. Never a tinted paragraph of help: help is one
 * sentence in the lede, or behind a disclosure.
 *
 * `neutral` — a fact worth setting apart; `info` — where to go next;
 * `warn` — needs you; `bad` — stopped, refused, failed; `ok` — done (rare:
 * the absence of a problem needs no box), drawn in the accent with a check:
 * green is for checklist ticks only (style guide, "Colour").
 */
import type { Tone } from '@/lib/vocabulary';

import { toneOfBadge, type BadgeTone } from './Badge.tsx';
import styles from './Callout.module.css';
import { Icon, type IconName } from './Icon.tsx';

const TONE_ICON: Readonly<Record<Tone, IconName | null>> = {
  neutral: null,
  info: 'info',
  ok: 'check',
  warn: 'alert',
  bad: 'alert',
};

const BADGE_TONES: readonly string[] = ['success', 'warning', 'danger'];

function toneOf(tone: Tone | BadgeTone): Tone {
  return BADGE_TONES.includes(tone) ? toneOfBadge(tone as BadgeTone) : (tone as Tone);
}

export function Callout({
  tone = 'neutral',
  title,
  children,
  action,
  testId,
}: {
  tone?: Tone | BadgeTone;
  title?: React.ReactNode;
  children: React.ReactNode;
  /** One action at the end of the note (a small `Button` or `ButtonLink`). */
  action?: React.ReactNode;
  testId?: string;
}) {
  const resolved = toneOf(tone);
  const toneIcon = TONE_ICON[resolved];
  return (
    <div
      className={[styles.callout, styles[`tone_${resolved}`]].join(' ')}
      role="note"
      data-tone={resolved}
      data-testid={testId}
    >
      {toneIcon && (
        <span className={styles.icon}>
          <Icon name={toneIcon} size={16} />
        </span>
      )}
      <div className={styles.body}>
        {title && <div className={styles.title}>{title}</div>}
        <div className={styles.text}>{children}</div>
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
