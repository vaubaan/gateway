'use client';

/**
 * The entries of the application bar, with the current section marked
 * (`aria-current="page"`, a heavier word and a rule under it). Client only
 * because the current path is known in the browser; the entries and their
 * counts are rendered by the server shell.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { isCurrentSection } from './nav';
import styles from './shell.module.css';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Rendered by the server: a count shown after the label. */
  readonly count?: React.ReactNode;
  /** Current on its own path only, not on the pages under it (an index among siblings). */
  readonly exact?: boolean;
}

export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname() ?? '';
  return (
    <>
      {items.map((item) => {
        const current = item.exact ? pathname === item.href : isCurrentSection(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={[styles.navLink, current ? styles.navLinkOn : ''].join(' ')}
            aria-current={current ? 'page' : undefined}
          >
            {item.label}
            {item.count}
          </Link>
        );
      })}
    </>
  );
}
