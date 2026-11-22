'use client';

/**
 * The local navigation of Settings in the side column, right under its entry (the last
 * of the main navigation): drawn only while the path is in Settings (`/settings`,
 * `/admin`, `/design`), so the pages of Settings are one click away from each other
 * without a row of tabs above the page. "You", then "Administration" for an
 * administrator (`settings-nav.ts`).
 *
 * A wide window only: when the column collapses to its icons, or on a phone, the same
 * entries are drawn above the page by `SettingsFrame` (`AppShell.tsx`). Both are named
 * "Settings"; only one is ever shown.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import type { SubNavGroup } from '@/components/ui';
import { NAV } from '@/lib/vocabulary';

import { isCurrentSection, sectionOf } from './nav';
import styles from './shell.module.css';

export function SettingsSideNav({ groups }: { groups: readonly SubNavGroup[] }) {
  const pathname = usePathname() ?? '';
  if (sectionOf(pathname) !== 'settings') return null;
  return (
    <nav className={styles.sideSub} aria-label={NAV.settings.label} data-testid="settings-side-nav">
      {groups.map((group, index) => (
        <div key={group.label ?? index} className={styles.sideSubGroup}>
          {group.label && <div className={styles.sideSubLabel}>{group.label}</div>}
          <ul className={styles.sideSubList}>
            {group.items.map((item) => {
              const current =
                item.current ??
                (item.exact ? pathname === item.href : isCurrentSection(pathname, item.href));
              return (
                <li key={item.href}>
                  <Link
                    // nosemgrep: react-href-var -- href comes from the static table of settings-nav.ts, never from input
                    href={item.href}
                    className={[styles.sideSubLink, current ? styles.sideSubLinkOn : ''].join(' ')}
                    aria-current={current ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
