'use client';

/**
 * Type-to-confirm modal for terminal actions (revoke a mission, revoke a connection).
 *
 * Render conditionally: `{open && <DangerConfirm ... />}`. The component takes
 * a `phrase` the user must type literally before the Confirm button enables.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';

/**
 * Tab and Shift+Tab stay inside the panel (style guide §5): from its last
 * control Tab goes to the first, from the first Shift+Tab goes to the last,
 * and a focus that got outside is brought back in.
 */
function keepFocusInside(event: KeyboardEvent, panel: HTMLElement | null): void {
  if (!panel) return;
  const controls = [
    ...panel.querySelectorAll<HTMLElement>('input, button, a[href], [tabindex]'),
  ].filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  const outside = !(active instanceof Node) || !panel.contains(active);
  if (event.shiftKey ? active === first || outside : active === last || outside) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

export function DangerConfirm({
  title,
  body,
  phrase,
  confirmLabel = 'Delete',
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  phrase: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel();
      if (e.key === 'Tab') keepFocusInside(e, panelRef.current);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const matches = value === phrase;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="danger-confirm-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 100,
        padding: 'var(--space-4)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={panelRef}
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-5)',
          display: 'grid',
          gap: 'var(--space-3)',
        }}
      >
        <h2
          id="danger-confirm-title"
          style={{ margin: 0, fontSize: 'var(--text-lg)', color: 'var(--accent-danger-fg)' }}
        >
          {title}
        </h2>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
          {body}
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          Type <code>{phrase}</code> to confirm:
        </div>
        <input
          ref={inputRef}
          aria-label={`Type ${phrase} to confirm`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          style={{
            width: '100%',
            padding: '8px 12px',
            background: 'var(--surface-base)',
            color: 'var(--text-foreground)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-base)',
            fontFamily: 'var(--font-geist-mono, ui-monospace)',
          }}
        />
        {error && (
          <p style={{ margin: 0, color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)' }}>
            {error}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} disabled={busy || !matches}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
