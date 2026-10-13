'use client';

/**
 * Tabs: a list of tabs with the roles and the keyboard of the ARIA pattern
 * (arrows, Home, End; a tab is activated when it takes focus), and a panel.
 * The state is the caller's, so that a page can also select a tab from a URL
 * fragment.
 */
import { useRef } from 'react';

import styles from './Tabs.module.css';

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
    <div ref={list} role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
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
            className={[styles.tab, selected ? styles.tabOn : ''].join(' ')}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && <span className={styles.count}>{tab.count}</span>}
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
