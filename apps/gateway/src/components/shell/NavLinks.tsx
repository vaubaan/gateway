'use client';

/**
 * The entries of the navigation, with the current section marked
 * (`aria-current="page"`, a fill and a heavier word). Client only because the
 * current path is known in the browser; the entries and their counts are
 * rendered by the server shell.
 *
 * Three forms of one list, chosen by the width of the window (the sheet of
 * the shell):
 *
 * - wide: the side column, an icon and its word per entry;
 * - narrow: the column collapses to its icons — the word stays in the
 *   document for assistive technology and is the `title` of the link;
 * - a phone: a bar at the bottom of the screen, **an icon and a word** per
 *   entry — a finger has no tooltip, so an icon alone would say nothing. The
 *   bar holds the four places a person goes to every day (`PHONE_BAR`) and
 *   "More", which opens the others in a sheet above it. The seven entries
 *   stay seven; none is removed on a phone.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import { Icon, type IconName } from '@/components/ui';
import { NAV_MORE, NAV_SHORT, type NavKey } from '@/lib/vocabulary';

import { PHONE_BAR, sectionOf } from './nav';
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

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** The word under an icon of the phone bar: the entry's own, or its short form. */
function NavWords({ item }: { item: NavItem }) {
  const short = NAV_SHORT[item.key];
  return (
    <>
      <span className={classes(styles.navLabel, short !== undefined && styles.navLabelLong)}>
        {item.label}
      </span>
      {short !== undefined && (
        // The link is named by the full label above; this is its drawing on a phone.
        <span className={styles.navLabelShort} aria-hidden="true">
          {short}
        </span>
      )}
    </>
  );
}

export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname() ?? '';
  const current = sectionOf(pathname);
  const [moreOpen, setMoreOpen] = useState(false);
  const more = useRef<HTMLLIElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const sheetId = useId();
  const overflow = items.filter((item) => !PHONE_BAR.includes(item.key));
  const currentInMore = overflow.some((item) => item.key === current);

  // Going somewhere closes the sheet.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setMoreOpen(false);
      moreButton.current?.focus();
    }
    function onPointer(event: PointerEvent) {
      if (event.target instanceof Node && !more.current?.contains(event.target)) setMoreOpen(false);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [moreOpen]);

  const link = (item: NavItem, extra?: string) => {
    const on = item.key === current;
    return (
      <Link
        href={item.href}
        className={classes(styles.navLink, on && styles.navLinkOn, extra)}
        aria-current={on ? 'page' : undefined}
        title={item.label}
        data-nav={item.key}
      >
        <Icon name={ICONS[item.key]} className={styles.navIcon} />
        <NavWords item={item} />
        {item.count}
      </Link>
    );
  };

  return (
    <ul className={styles.navList}>
      {items.map((item) => (
        <li
          key={item.key}
          className={classes(
            item.ruleBefore && styles.navRuled,
            !PHONE_BAR.includes(item.key) && styles.navBeyondBar,
          )}
        >
          {link(item)}
        </li>
      ))}
      {overflow.length > 0 && (
        // Drawn on a phone only: the entries the bar has no room for.
        <li ref={more} className={styles.navMore}>
          <button
            ref={moreButton}
            type="button"
            className={classes(styles.navLink, currentInMore && styles.navLinkOn)}
            aria-expanded={moreOpen}
            aria-controls={sheetId}
            data-testid="nav-more"
            onClick={() => setMoreOpen((open) => !open)}
          >
            <Icon name="more" className={styles.navIcon} />
            <span className={styles.navLabel}>{NAV_MORE}</span>
          </button>
          {/* Filled only while open: closed, each entry is in the document once. */}
          <ul id={sheetId} className={styles.navSheet} hidden={!moreOpen} data-testid="nav-sheet">
            {moreOpen &&
              overflow.map((item) => <li key={item.key}>{link(item, styles.navSheetLink)}</li>)}
          </ul>
        </li>
      )}
    </ul>
  );
}
