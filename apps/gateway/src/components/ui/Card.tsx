/**
 * A bordered box. A border, a fill and a shadow are each a claim that
 * something is a separate object, so a page uses a card **once at most**: the
 * rail that summarises what is being created, the one thing set apart. Lists
 * are `Rows` or a `DataTable`, never cards; a region is a `Section`.
 */
import { type HTMLAttributes } from 'react';

import styles from './Card.module.css';

function join(base: string | undefined, extra: string | undefined): string {
  return [base ?? '', extra ?? ''].filter(Boolean).join(' ');
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={join(styles.card, className)} {...rest} />;
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={join(styles.header, className)} {...rest} />;
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className={styles.title}>{children}</h3>;
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={join(styles.body, className)} {...rest} />;
}

/** The foot of the rail: the one primary action of the page, and a quiet hint. */
export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={join(styles.footer, className)} {...rest} />;
}
