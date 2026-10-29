'use client';

/**
 * The trail of a page: what the path bar of the shell draws after the section
 * (docs/handbook/web-app.md). A page declares it once, in its
 * `PageHeader`: its crumbs and its title. The bar reads it; nothing else does.
 *
 * `TrailProvider` wraps the shell; `TrailSetter` is rendered by the header and
 * publishes its items while it is mounted; `useTrail` is read by the bar.
 * Before hydration the trail is empty and the bar draws the instance and the
 * section only, which it knows from the route.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useState } from 'react';

export interface TrailItem {
  readonly label: React.ReactNode;
  /** A link for every item but the last. */
  readonly href?: string;
}

interface TrailStore {
  readonly items: readonly TrailItem[];
  readonly set: (items: readonly TrailItem[]) => void;
}

const EMPTY: readonly TrailItem[] = [];
const TrailContext = createContext<TrailStore>({ items: EMPTY, set: () => {} });

export function TrailProvider({ children }: { children: React.ReactNode }) {
  const [items, set] = useState<readonly TrailItem[]>(EMPTY);
  const store = useMemo<TrailStore>(() => ({ items, set }), [items]);
  return <TrailContext.Provider value={store}>{children}</TrailContext.Provider>;
}

/** What the current page declared: empty outside a page or before hydration. */
export function useTrail(): readonly TrailItem[] {
  return useContext(TrailContext).items;
}

/** Rendered by a page header: publishes the items while the header is mounted. */
export function TrailSetter({ items }: { items: readonly TrailItem[] }) {
  const { set } = useContext(TrailContext);
  // The items are built anew on every render; what they say is what matters.
  const key = JSON.stringify(items.map((item) => [textOf(item.label), item.href ?? null]));
  useLayoutEffect(() => {
    set(items);
    return () => set(EMPTY);
  }, [set, key]);
  return null;
}

/** The text of a label, for comparing two items: a node without text compares by its type. */
export function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props: { children?: React.ReactNode } }).props;
    return textOf(props.children);
  }
  return '';
}
