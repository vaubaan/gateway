'use client';

/**
 * Help that stays out of the way: one line at most is always shown, the rest
 * unfolds behind a button and stays unfolded for this browser (the choice is
 * remembered per `id`). Closed by default, on every page, for everyone.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { Glyph } from './Glyph.tsx';
import styles from './Help.module.css';

const STORAGE_PREFIX = 'vaubaan:help:';

function remembered(id: string): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${id}`) === 'open';
  } catch {
    // Storage refused (private mode, policy): the help simply starts closed.
    return false;
  }
}

function remember(id: string, open: boolean): void {
  try {
    if (open) window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, 'open');
    else window.localStorage.removeItem(`${STORAGE_PREFIX}${id}`);
  } catch {
    // Not remembered; nothing else changes.
  }
}

/** The state of one help block, remembered per browser. */
export function useHelp(id: string): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Read after hydration: the server always renders the help closed.
    if (remembered(id)) setOpen(true);
  }, [id]);
  // Stable, so that a caller may list it among the dependencies of an effect.
  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      remember(id, next);
    },
    [id],
  );
  return [open, set];
}

/** The button of a help block whose panel is rendered elsewhere on the page. */
export function HelpButton({
  open,
  onToggle,
  controls,
  label = 'How to read this',
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      className={styles.button}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Glyph name="help" />
      {label}
    </button>
  );
}

/** One line, then "More": the inline helper of a form or a list. */
export function Help({
  id,
  line,
  label = 'More',
  children,
}: {
  /** Stable name of this help block: the key its state is remembered under. */
  id: string;
  /** The one sentence that is always shown. */
  line?: React.ReactNode;
  label?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useHelp(id);
  const panelId = useId();
  return (
    <div className={styles.help} data-testid={`help-${id}`}>
      <p className={styles.line}>
        {line && <span>{line} </span>}
        <HelpButton
          open={open}
          onToggle={() => setOpen(!open)}
          controls={panelId}
          label={open ? 'Less' : label}
        />
      </p>
      <div id={panelId} className={styles.panel} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
