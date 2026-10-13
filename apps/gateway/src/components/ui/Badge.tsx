/**
 * Marks of state. The rule they serve: **a status is coloured only when it
 * differs from normal.** Nothing is ever labelled "active" or "allowed" in
 * colour; amber means "needs you", red means "stopped, refused, limit
 * reached". Every mark carries its word: never colour alone.
 *
 * - `StatusMark` — a pill with a dot, for the exception on a row or a title.
 * - `Dot` — the dot alone, next to a word that already says the state.
 * - `Tag` — a small squared label for a fact that is not a state: an
 *   environment (`staging`, `prod`), a short code.
 * - `Badge` — the neutral inline label older pages use; same tones as before.
 */
import type { CSSProperties } from 'react';

import type { Tone } from '@/lib/vocabulary';

import styles from './Badge.module.css';

export type { Tone };

/** The tone names of the first interface, kept for the pages that still use them. */
export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_OF_BADGE: Readonly<Record<BadgeTone, Tone>> = {
  neutral: 'neutral',
  info: 'info',
  success: 'ok',
  warning: 'warn',
  danger: 'bad',
};

export function toneOfBadge(tone: BadgeTone): Tone {
  return TONE_OF_BADGE[tone];
}

export function StatusMark({
  tone = 'neutral',
  dot = true,
  children,
  testId,
}: {
  tone?: Tone;
  /** The dot before the word; a count ("2") takes none. */
  dot?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <span
      className={[styles.pill, styles[`tone_${tone}`], dot ? styles.dotted : ''].join(' ')}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'neutral', label }: { tone?: Tone; label?: string }) {
  return (
    <span
      className={[styles.dot, styles[`dot_${tone}`]].join(' ')}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** The environments the catalogs know; anything else is drawn neutral. */
const ENVIRONMENT_TONE: Readonly<Record<string, Tone>> = {
  prod: 'bad',
  production: 'bad',
  live: 'bad',
  staging: 'warn',
  preview: 'warn',
  test: 'ok',
  dev: 'ok',
  development: 'ok',
};

export function Tag({
  tone = 'neutral',
  mono = false,
  dashed = false,
  children,
}: {
  tone?: Tone;
  mono?: boolean;
  /** "Nothing here": a missing label, an option that is not available. */
  dashed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={[
        styles.tag,
        styles[`tag_${tone}`],
        mono ? styles.mono : '',
        dashed ? styles.dashed : '',
      ].join(' ')}
    >
      {children}
    </span>
  );
}

/** An environment label: the word, with the tone production deserves. `null` → "no label". */
export function EnvTag({ env }: { env: string | null | undefined }) {
  if (!env) return <Tag dashed>no label</Tag>;
  return <Tag tone={ENVIRONMENT_TONE[env.toLowerCase()] ?? 'neutral'}>{env}</Tag>;
}

export function Badge({
  tone = 'neutral',
  children,
  mono = false,
  style,
  className,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  mono?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const classes = [
    styles.tag,
    styles[`tag_${TONE_OF_BADGE[tone]}`],
    mono ? styles.mono : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} style={style}>
      {children}
    </span>
  );
}
