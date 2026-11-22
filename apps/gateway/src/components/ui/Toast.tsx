'use client';

/**
 * A toast confirms what the person just did, without taking the page from
 * them: "Key replaced", "Copied", "Access removed". It appears at the bottom
 * of the window, is announced politely, and leaves on its own after a few
 * seconds (a failure stays until dismissed).
 *
 * A toast never carries the only copy of something that matters: a refusal,
 * a consequence or a secret is shown on the page, where it stays.
 *
 * `ToastProvider` is mounted once by the application shell; a client
 * component calls `useToast()` and then `toast({ title })`. `ToastCard` is
 * the card alone (the gallery). Drawn as shadcn/ui's toast on the shared tokens
 * (ADR design-system-on-shadcn-shared-by-the-app-and-the-site); no third-party
 * toaster: the queue is these few lines.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';
import type { Tone } from '@/lib/vocabulary';

import { Icon } from './Icon.tsx';

const LIFETIME_MS = 5000;
const MAX_SHOWN = 3;

export interface ToastMessage {
  readonly title: React.ReactNode;
  /** One more sentence, when the title cannot say it all. */
  readonly description?: React.ReactNode;
  /** `bad` for a failure: it stays until dismissed. Default: neutral. */
  readonly tone?: Extract<Tone, 'neutral' | 'ok' | 'bad'>;
}

interface Shown extends ToastMessage {
  readonly id: number;
}

type Push = (message: ToastMessage) => void;

const ToastContext = createContext<Push | null>(null);

export function ToastCard({
  title,
  description,
  tone = 'neutral',
  onDismiss,
}: ToastMessage & { onDismiss?: () => void }) {
  return (
    <div
      className="pointer-events-auto flex animate-rise items-start gap-2.5 rounded-lg bg-popover px-3 py-2.5 text-small text-popover-foreground shadow-md"
      data-tone={tone}
    >
      {tone !== 'neutral' && (
        <span
          className={cn(
            'mt-0.5 inline-flex flex-none',
            // A success is said in the accent: green is for checklist ticks only. A failure is
            // said in ink: red is kept for stopped, refused, limit reached.
            tone === 'ok' ? 'text-primary' : 'text-foreground',
          )}
        >
          <Icon name={tone === 'ok' ? 'check' : 'alert'} size={14} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        {description && <div className="text-muted-foreground">{description}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          className="-mt-0.5 -mr-1 inline-grid size-6 flex-none place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <Icon name="cross" size={12} />
        </button>
      )}
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState<readonly Shown[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setShown((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback<Push>((message) => {
    const id = nextId.current++;
    setShown((current) => [...current, { ...message, id }].slice(-MAX_SHOWN));
  }, []);

  // A toast that is not a failure leaves on its own.
  useEffect(() => {
    const timers = shown
      .filter((toast) => toast.tone !== 'bad')
      .map((toast) => window.setTimeout(() => dismiss(toast.id), LIFETIME_MS));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [shown, dismiss]);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed right-6 bottom-6 z-[200] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
        role="status"
        aria-live="polite"
        data-testid="toasts"
      >
        {shown.map((toast) => (
          <ToastCard key={toast.id} {...toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** `const toast = useToast(); toast({ title: 'Key replaced' });` */
export function useToast(): Push {
  const push = useContext(ToastContext);
  if (!push) throw new Error('useToast must be called under the application shell (ToastProvider)');
  return push;
}
