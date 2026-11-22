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

import { cn } from '@/lib/utils';

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
    <nav
      // The local navigation of a place: a row of tabs under the path bar, as wide as the page
      // column, flush under the bar (the page's own top padding is taken back). A phone: one
      // labelled row of chips per group, not sticky — the screen is short.
      className="sticky top-(--bar-height) z-20 -mt-(--page-pad-top) mb-6 flex flex-wrap items-center gap-x-5 border-b border-border bg-background text-body max-[1023px]:-mt-6 max-sm:static max-sm:-mt-5 max-sm:mb-5 max-sm:flex-col max-sm:items-stretch max-sm:gap-3 max-sm:py-3"
      aria-label={label}
    >
      {groups.map((group, index) => (
        <div
          key={group.label ?? index}
          className="flex flex-wrap items-center gap-x-0.5 max-sm:gap-1.5"
        >
          {group.label && (
            // A group's name: a quiet word before its entries.
            <div className="pr-1 text-caption text-muted-foreground max-sm:basis-full max-sm:pr-0">
              {group.label}
            </div>
          )}
          {group.items.map((item) => {
            const current =
              item.current ?? (item.exact ? pathname === item.href : isUnder(pathname, item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  // The current entry: a heavier word and a rule under it, not a colour; the rule
                  // sits on the hairline of the row.
                  '-mb-px inline-flex min-h-9 items-center gap-2 border-b-2 px-2 whitespace-nowrap hover:text-foreground hover:no-underline focus-visible:rounded-sm focus-visible:outline-offset-[-2px] max-sm:m-0 max-sm:rounded-full max-sm:border max-sm:px-3',
                  current
                    ? 'border-foreground font-semibold text-foreground'
                    : 'border-transparent text-muted-foreground max-sm:border-border-strong',
                )}
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
    <div className="flex min-w-0 flex-col">
      {nav}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
