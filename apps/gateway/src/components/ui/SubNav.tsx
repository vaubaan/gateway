'use client';

/**
 * The local navigation of a page that is a small place of its own — Settings
 * (you, then administration), the Reference (one entry per service). A short
 * column on the left of the content: groups with a quiet label, entries with
 * the current one marked. The global navigation stays where it is.
 *
 * `SubNavFrame` lays the column beside the content; `SubNav` is the column.
 * An entry is current when the path is its `href` (or under it, unless
 * `exact`); a page that navigates by fragment passes `current` itself.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import styles from './SubNav.module.css';

export interface SubNavItem {
  readonly label: string;
  readonly href: string;
  /** A mark before the label (a `ServiceMark`). */
  readonly lead?: React.ReactNode;
  /** Current on its own path only, not on the pages under it. */
  readonly exact?: boolean;
  /** Decided by the caller (fragments, tabs) instead of the path. */
  readonly current?: boolean;
}

export interface SubNavGroup {
  /** "You", "Administration", "Services". */
  readonly label?: string;
  readonly items: readonly SubNavItem[];
}

function isUnder(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SubNav({ label, groups }: { label: string; groups: readonly SubNavGroup[] }) {
  const pathname = usePathname() ?? '';
  return (
    <nav className={styles.subnav} aria-label={label}>
      {groups.map((group, index) => (
        <div key={group.label ?? index} className={styles.group}>
          {group.label && <div className={styles.groupLabel}>{group.label}</div>}
          {group.items.map((item) => {
            const current =
              item.current ?? (item.exact ? pathname === item.href : isUnder(pathname, item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={[styles.item, current ? styles.itemOn : ''].join(' ')}
                aria-current={current ? 'page' : undefined}
              >
                {item.lead}
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function SubNavFrame({
  nav,
  children,
}: {
  nav: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.frame}>
      {nav}
      <div className={styles.content}>{children}</div>
    </div>
  );
}
