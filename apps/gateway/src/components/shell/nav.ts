/**
 * Which entry of the side navigation a path belongs to. Pure: the shell marks
 * the current section with it, and a unit test pins the rule.
 *
 * Seven entries (`lib/vocabulary`: `NAV_ORDER`). Every page of the
 * application sits under exactly one of them, including the pages that have
 * no entry of their own: the access received (`/shares`) is part of Accounts;
 * connected apps (`/delegations`), Administration (`/admin/**`) and the
 * interface reference (`/design`) are part of Settings.
 */
import { NAV, NAV_ORDER, type NavKey } from '@/lib/vocabulary';

/** `/missions/abc` is under `/missions`; `/missions-archive` is not. */
export function isCurrentSection(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The paths of a section besides the entry's own. */
const ALSO_UNDER: Readonly<Partial<Record<NavKey, readonly string[]>>> = {
  accounts: ['/shares'],
  settings: ['/delegations', '/admin', '/design'],
};

/** The section a path is in, or `null` outside the application (sign-in). */
export function sectionOf(pathname: string): NavKey | null {
  // Home is its own path only: every path is "under" `/`.
  if (pathname === NAV.now.href) return 'now';
  for (const key of NAV_ORDER) {
    if (key === 'now') continue;
    const prefixes = [NAV[key].href, ...(ALSO_UNDER[key] ?? [])];
    if (prefixes.some((prefix) => isCurrentSection(pathname, prefix))) return key;
  }
  return null;
}
