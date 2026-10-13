'use client';

/**
 * Everything else a page offers, behind "···" (style guide §1: one primary
 * action, at most two secondary ones visible, the rest behind "···").
 *
 * `MoreMenu` is the button and its panel; `MenuItem` is one act — a button,
 * or a link when it navigates. The panel is one of the few surfaces with a
 * shadow. It closes on Escape (the focus goes back to the button), on a click
 * outside and once an item was chosen; the arrow keys move between its items.
 * `danger` draws the words of an act that stops something in red: never a red
 * fill.
 */
import Link from 'next/link';
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';

import { Icon } from './Icon.tsx';
import styles from './Menu.module.css';

const CloseContext = createContext<() => void>(() => {});

export function MoreMenu({
  label = 'More actions',
  children,
  testId,
}: {
  /** Names the button for assistive technology and on hover. */
  label?: string;
  /** `MenuItem`s. */
  children: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const items = () =>
      [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter(
        (item) => !item.hasAttribute('disabled'),
      );
    items()[0]?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const all = items();
      const at = all.findIndex((item) => item === document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      all[(at + step + all.length) % all.length]?.focus();
    }
    function onPointer(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div ref={root} className={styles.root}>
      <button
        ref={button}
        type="button"
        className={styles.button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        title={label}
        data-testid={testId}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="more" size={16} />
      </button>
      <div ref={panel} id={panelId} role="menu" className={styles.panel} hidden={!open}>
        <CloseContext.Provider value={() => setOpen(false)}>{children}</CloseContext.Provider>
      </div>
    </div>
  );
}

export function MenuItem({
  children,
  href,
  onSelect,
  danger = false,
  disabled = false,
  note,
}: {
  /** The act, as a verb: "Replace key", "Stop the mission". */
  children: React.ReactNode;
  /** An item that navigates is a link. */
  href?: string;
  onSelect?: () => void;
  /** An act that stops or removes something. */
  danger?: boolean;
  disabled?: boolean;
  /** A few quiet words under the act: what it does, or why it is not available. */
  note?: React.ReactNode;
}) {
  const close = useContext(CloseContext);
  const classes = [styles.item, danger ? styles.danger : ''].join(' ');
  const content = (
    <>
      <span>{children}</span>
      {note && <span className={styles.note}>{note}</span>}
    </>
  );
  if (href && !disabled) {
    return (
      <Link href={href} role="menuitem" className={classes} onClick={close}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      className={classes}
      disabled={disabled}
      onClick={() => {
        close();
        onSelect?.();
      }}
    >
      {content}
    </button>
  );
}
