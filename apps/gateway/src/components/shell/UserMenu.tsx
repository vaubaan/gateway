'use client';

/**
 * The person, at the bottom of the side navigation: their mark, their name
 * and their email — cut with an ellipsis when long, whole in the title. It is
 * a button: behind it, what they are here (administrator, or nothing) and
 * "Sign out". Closes on Escape and on a click outside, and gives the focus
 * back to the button.
 */
import { useEffect, useId, useRef, useState } from 'react';

import { Avatar } from '@/components/ui';

import styles from './shell.module.css';

export function UserMenu({
  name,
  detail,
  children,
}: {
  /** Who is signed in: a name when the identity provider gave one, else the email. */
  name: string;
  /** The line under the name: the email, or what a session without a person is. */
  detail?: string;
  /** The role and the sign-out form, rendered by the server shell. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
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
        ref={button}
        type="button"
        className={styles.userButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account: ${name}`}
        title={detail ? `${name} · ${detail}` : name}
        data-testid="user-menu"
        onClick={() => setOpen((current) => !current)}
      >
        <Avatar name={name} />
        <span className={styles.userText}>
          <span className={styles.userName}>{name}</span>
          {detail && <span className={styles.userDetail}>{detail}</span>}
        </span>
      </button>
      <div id={panelId} className={styles.userPanel} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
