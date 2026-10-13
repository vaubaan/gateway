'use client';

/**
 * The entries of the side navigation, with the current section marked
 * (`aria-current="page"`, a fill and a heavier word). Client only because the
 * current path is known in the browser; the entries and their counts are
 * rendered by the server shell.
 *
 * In the collapsed form (a narrow window) only the icon shows: the label
 * stays in the document for assistive technology and is the `title` of the
 * link, so nothing is said by an icon alone.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon, type IconName } from '@/components/ui';
import type { NavKey } from '@/lib/vocabulary';

import { sectionOf } from './nav';
import styles from './shell.module.css';

export interface NavItem {
  readonly key: NavKey;
  readonly href: string;
  readonly label: string;
  /** Rendered by the server: a count shown at the end of the entry. */
  readonly count?: React.ReactNode;
  /** A hairline before the entry (Settings stands apart). */
  readonly ruleBefore?: boolean;
}

/** Keyed by entry: a new entry fails to compile until it has its icon. */
const ICONS: Readonly<Record<NavKey, IconName>> = {
  now: 'now',
  waiting: 'waiting',
  missions: 'missions',
  accounts: 'accounts',
  activity: 'activity',
  reference: 'reference',
  settings: 'settings',
};

export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const current = sectionOf(usePathname() ?? '');
  return (
    <ul className={styles.navList}>
      {items.map((item) => {
        const on = item.key === current;
        return (
          <li key={item.key} className={item.ruleBefore ? styles.navRuled : undefined}>
            <Link
              href={item.href}
              className={[styles.navLink, on ? styles.navLinkOn : ''].join(' ')}
              aria-current={on ? 'page' : undefined}
              title={item.label}
              data-nav={item.key}
            >
              <Icon name={ICONS[item.key]} className={styles.navIcon} />
              <span className={styles.navLabel}>{item.label}</span>
              {item.count}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
