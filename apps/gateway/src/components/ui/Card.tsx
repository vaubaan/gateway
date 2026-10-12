import { type HTMLAttributes } from 'react';
import styles from './Card.module.css';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={[styles.card, className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={[styles.header, className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className={styles.title}>{children}</h3>;
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={[styles.body, className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={[styles.footer, className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}
