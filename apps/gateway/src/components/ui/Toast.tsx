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
 * the card alone (the gallery).
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

import type { Tone } from '@/lib/vocabulary';

import { Icon } from './Icon.tsx';
import styles from './Toast.module.css';

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
    <div className={[styles.toast, styles[`tone_${tone}`]].join(' ')} data-tone={tone}>
      {tone !== 'neutral' && (
        <span className={styles.icon}>
          <Icon name={tone === 'ok' ? 'check' : 'alert'} size={14} />
        </span>
      )}
      <div className={styles.text}>
        <div className={styles.title}>{title}</div>
        {description && <div className={styles.description}>{description}</div>}
      </div>
      {onDismiss && (
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
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
      <div className={styles.region} role="status" aria-live="polite" data-testid="toasts">
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
