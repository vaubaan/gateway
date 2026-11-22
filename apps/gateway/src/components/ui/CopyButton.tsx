'use client';

/**
 * Copies a text to the clipboard and says so: the button reads "Copied" for
 * two seconds, and the change is announced to assistive technology. When the
 * browser refuses the clipboard (an insecure origin, a denied permission) the
 * button says "Select and copy" instead of pretending. Tailwind on the shared
 * tokens; on a code block, the dark control.
 */
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { ACTIONS } from '@/lib/vocabulary';

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
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-md border px-2 text-caption',
        onDark
          ? 'h-6 border-code-border bg-code-border text-code-fg hover:bg-code-muted/30'
          : 'h-7 border-border-strong bg-card text-foreground hover:bg-accent',
        className,
      )}
      onClick={() => void copy()}
    >
      <span aria-live="polite">
        {state === 'copied' ? ACTIONS.copied : state === 'refused' ? 'Select and copy' : label}
      </span>
    </button>
  );
}
