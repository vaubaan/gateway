import type { HTMLAttributes } from 'react';
import styles from './Code.module.css';

export function Code({ children, className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <code {...rest} className={[styles.code, className ?? ''].join(' ')}>
      {children}
    </code>
  );
}

export function KeyHint({ children }: { children: React.ReactNode }) {
  return <kbd className={styles.kbd}>{children}</kbd>;
}
