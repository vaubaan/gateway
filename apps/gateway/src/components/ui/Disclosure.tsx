'use client';

/**
 * Details on demand. The default view of a page shows what a person acts on;
 * the rest is one click away, **per page, and the page remembers** — never a
 * global "compact" setting (an administrator wants the detail on this
 * mission, not on every page).
 *
 * - `Disclosure` — a quiet link ("All 26", "Edit the permissions one by one",
 *   "Show details") and the panel it opens under itself.
 * - `DetailScope` + `DetailToggle` + `DetailOnly` — the same choice shared by
 *   several things of a region: the toggle sits in a section heading, and
 *   everything marked as detail inside the scope follows it — the `detail`
 *   columns of a `DataTable`, and any block wrapped in `DetailOnly`. The
 *   content may be rendered by the server: the scope only flips an attribute.
 *
 * The state is remembered in this browser under the `id` given (make it name
 * the page and the region: `mission:people`). The server always renders
 * closed; the remembered state applies after hydration.
 */
import { createContext, useCallback, useContext, useEffect, useId, useState } from 'react';

import { ACTIONS } from '@/lib/vocabulary';

/** The parts of a disclosure, on Tailwind and the shared tokens. */
const S = {
  disclosure: 'min-w-0',
  // A link that acts: the accent, no box.
  toggle: 'cursor-pointer p-0 text-left text-small text-primary hover:underline',
  panel: 'mt-3',
  // Shown while the nearest scope is open; a scope inside an open one keeps its own answer.
  detailOnly: 'hidden [[data-details=open]_&:not([data-details=closed]_&)]:block',
} as const;

const STORAGE_PREFIX = 'vaubaan:open:';

function readRemembered(id: string): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${id}`) === '1';
  } catch {
    // Storage refused (private mode, policy): the disclosure simply starts closed.
    return false;
  }
}

function writeRemembered(id: string, open: boolean): void {
  try {
    if (open) window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, '1');
    else window.localStorage.removeItem(`${STORAGE_PREFIX}${id}`);
  } catch {
    // Not remembered; nothing else changes.
  }
}

/** An open/closed state remembered per browser under `id`. `null` id: not remembered. */
export function useRemembered(
  id: string | null,
  defaultOpen = false,
): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    // Read after hydration: the server always renders the default.
    if (id !== null && readRemembered(id)) setOpen(true);
  }, [id]);
  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (id !== null) writeRemembered(id, next);
    },
    [id],
  );
  return [open, set];
}

function ToggleButton({
  open,
  onToggle,
  controls,
  show,
  hide,
}: {
  open: boolean;
  onToggle: () => void;
  controls?: string;
  show: React.ReactNode;
  hide: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={S.toggle}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      {open ? hide : show}
    </button>
  );
}

export function Disclosure({
  id,
  show = ACTIONS.showDetails,
  hide = ACTIONS.hideDetails,
  defaultOpen = false,
  remember = true,
  children,
  testId,
}: {
  /** Names the page and the region; the state is remembered under it. */
  id: string;
  /** The words of the link when closed: say what will appear ("All 26", "Show the 14 unused"). */
  show?: React.ReactNode;
  hide?: React.ReactNode;
  defaultOpen?: boolean;
  /** `false` for a disclosure whose state should not outlive the page. */
  remember?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useRemembered(remember ? id : null, defaultOpen);
  const panelId = useId();
  return (
    <div className={S.disclosure} data-testid={testId}>
      <ToggleButton
        open={open}
        onToggle={() => setOpen(!open)}
        controls={panelId}
        show={show}
        hide={hide}
      />
      <div id={panelId} className={S.panel} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

interface Scope {
  readonly open: boolean;
  readonly toggle: () => void;
}

const ScopeContext = createContext<Scope | null>(null);

export function DetailScope({
  id,
  defaultOpen = false,
  children,
}: {
  /** Names the page and the region (`mission:people`). */
  id: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useRemembered(id, defaultOpen);
  return (
    <ScopeContext.Provider value={{ open, toggle: () => setOpen(!open) }}>
      <div data-details={open ? 'open' : 'closed'} data-detail-scope={id}>
        {children}
      </div>
    </ScopeContext.Provider>
  );
}

/** The link that opens and closes the nearest `DetailScope`. */
export function DetailToggle({
  show = ACTIONS.showDetails,
  hide = ACTIONS.hideDetails,
}: {
  show?: React.ReactNode;
  hide?: React.ReactNode;
}) {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error('DetailToggle must be rendered inside a DetailScope');
  return <ToggleButton open={scope.open} onToggle={scope.toggle} show={show} hide={hide} />;
}

/** A block shown only while the nearest `DetailScope` is open. No hook: server-renderable. */
export function DetailOnly({ children }: { children: React.ReactNode }) {
  return <div className={S.detailOnly}>{children}</div>;
}
