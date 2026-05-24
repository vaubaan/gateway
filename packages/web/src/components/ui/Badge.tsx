import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export function Badge({
  tone = 'neutral',
  children,
  mono = false,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <span className={[styles.badge, styles[`tone_${tone}`], mono ? styles.mono : ''].join(' ')}>
      {children}
    </span>
  );
}
