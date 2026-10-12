import type { CSSProperties } from 'react';

import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

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
  const classes = [styles.badge, styles[`tone_${tone}`], mono ? styles.mono : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} style={style}>
      {children}
    </span>
  );
}
