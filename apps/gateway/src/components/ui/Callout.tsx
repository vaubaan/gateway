/**
 * A note that interrupts on purpose: an icon, a short title, a sentence or
 * two. Used sparingly — the four notes of the risk model (fallback, token
 * hand-out, deprecated, experimental) — and never as a tinted paragraph: the
 * surface stays neutral, only the icon and the title carry the tone.
 */
import type { BadgeTone } from './Badge.tsx';
import styles from './Callout.module.css';
import { Glyph, type GlyphName } from './Glyph.tsx';

const TONE_GLYPH: Readonly<Record<BadgeTone, GlyphName>> = {
  neutral: 'info',
  info: 'info',
  success: 'info',
  warning: 'warning',
  danger: 'warning',
};

export function Callout({
  tone = 'info',
  icon,
  title,
  children,
  testId,
}: {
  tone?: BadgeTone;
  icon?: GlyphName;
  title: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={[styles.callout, styles[`tone_${tone}`]].join(' ')}
      role="note"
      data-testid={testId}
    >
      <span className={styles.icon}>
        <Glyph name={icon ?? TONE_GLYPH[tone]} />
      </span>
      <div className={styles.body}>
        <div className={styles.title}>{title}</div>
        <div className={styles.text}>{children}</div>
      </div>
    </div>
  );
}
