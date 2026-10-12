import styles from './Banner.module.css';
import type { BadgeTone } from './Badge.tsx';

export function Banner({
  tone = 'info',
  title,
  children,
}: {
  tone?: BadgeTone;
  title?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={[styles.banner, styles[`tone_${tone}`]].join(' ')}>
      {title && <div className={styles.title}>{title}</div>}
      <div>{children}</div>
    </div>
  );
}
