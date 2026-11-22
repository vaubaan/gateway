'use client';

/**
 * Tabs: a list of tabs with the roles and the keyboard of the ARIA pattern
 * (arrows, Home, End; a tab is activated when it takes focus), and a panel.
 * The state is the caller's, so that a page can also select a tab from a URL
 * fragment. Drawn as shadcn/ui's Tabs (the line variant) on the shared tokens;
 * the list and its panels stay separate elements, so a page can place them
 * apart, which Radix's Tabs would not allow.
 */
import { useRef } from 'react';

import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: string;
  /** A count shown after the label. */
  readonly count?: number;
}

export function tabId(base: string, id: string): string {
  return `${base}-tab-${id}`;
}
export function panelId(base: string, id: string): string {
  return `${base}-panel-${id}`;
}

export function TabList<T extends string>({
  base,
  label,
  tabs,
  active,
  onSelect,
}: {
  /** Prefix of the element ids, unique on the page. */
  base: string;
  label: string;
  tabs: readonly TabItem<T>[];
  active: T;
  onSelect: (id: T) => void;
}) {
  const list = useRef<HTMLDivElement>(null);

  function focusTab(index: number) {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    onSelect(tab.id);
    document.getElementById(tabId(base, tab.id))?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const current = tabs.findIndex((tab) => tab.id === active);
    if (event.key === 'ArrowRight') focusTab(current + 1);
    else if (event.key === 'ArrowLeft') focusTab(current - 1);
    else if (event.key === 'Home') focusTab(0);
    else if (event.key === 'End') focusTab(tabs.length - 1);
    else return;
    event.preventDefault();
  }

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className="flex min-w-0 gap-4 overflow-x-auto border-b border-border"
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(base, tab.id)}
            aria-selected={selected}
            aria-controls={panelId(base, tab.id)}
            tabIndex={selected ? 0 : -1}
            // The selected tab: a heavier word and a rule under it, not a colour. The rule
            // sits on the hairline of the list.
            className={cn(
              '-mb-px inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 text-body transition-colors focus-visible:rounded-sm focus-visible:outline-offset-[-2px]',
              selected
                ? 'border-foreground font-semibold text-foreground'
                : 'border-transparent font-normal text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="text-caption font-normal tabular-nums text-muted-foreground">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  base,
  id,
  children,
  className,
}: {
  base: string;
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(base, id)}
      aria-labelledby={tabId(base, id)}
      // A panel is reachable by Tab even when nothing in it is focusable.
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
}
