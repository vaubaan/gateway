'use client';

/**
 * The account, in one compact control at the end of the application bar: a
 * button that names who is signed in — cut with an ellipsis when it is long,
 * whole in its title — and behind it the role and "Sign out". It keeps the
 * bar on one line whatever the length of the email. Closes on Escape and on a
 * click outside.
 */
import { useEffect, useId, useRef, useState } from 'react';

import { Glyph } from '@/components/ui';

import styles from './shell.module.css';

export function UserMenu({
  name,
  children,
}: {
  /** Who is signed in (`alice@example.com`). */
  name: string;
  /** The role badge and the sign-out form, rendered by the server shell. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
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
    <div ref={root} className={styles.user}>
      <button
        type="button"
        className={styles.userButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account: ${name}`}
        title={name}
        data-testid="user-menu"
        onClick={() => setOpen((current) => !current)}
      >
        <Glyph name="user" />
        <span className={styles.userName}>{name}</span>
        <Glyph name="chevron" className={styles.userChevron} />
      </button>
      <div id={panelId} className={styles.userPanel} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
