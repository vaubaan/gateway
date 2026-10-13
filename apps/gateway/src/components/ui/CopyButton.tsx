'use client';

/**
 * Copies a text to the clipboard and says so: the button reads "Copied" for
 * two seconds, and the change is announced to assistive technology. When the
 * browser refuses the clipboard (an insecure origin, a denied permission) the
 * button says "Select and copy" instead of pretending.
 */
import { useEffect, useState } from 'react';

import { ACTIONS } from '@/lib/vocabulary';

import styles from './CopyButton.module.css';

const FEEDBACK_MS = 2000;

type State = 'idle' | 'copied' | 'refused';

export function CopyButton({
  text,
  label = ACTIONS.copy,
  className,
  onDark = false,
}: {
  text: string;
  label?: string;
  className?: string;
  /** Drawn on a code block: the dark control. */
  onDark?: boolean;
}) {
  const [state, setState] = useState<State>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('refused');
    }
  }

  return (
    <button
      type="button"
      className={[styles.copy, onDark ? styles.onDark : '', className ?? ''].join(' ')}
      onClick={() => void copy()}
    >
      <span aria-live="polite">
        {state === 'copied' ? ACTIONS.copied : state === 'refused' ? 'Select and copy' : label}
      </span>
    </button>
  );
}
