'use client';

import { useEffect, useRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from './cn';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly className?: string;
  /** Click on the backdrop dismisses the dialog. Default: true. */
  readonly dismissOnBackdropClick?: boolean;
  /** Label for screen-readers if the dialog has no explicit title. */
  readonly ariaLabel?: string;
}

/**
 * Native <dialog>-backed modal. Browser handles focus trap + ESC for free.
 * We layer click-outside-to-close and ensure ESC dispatches onClose.
 */
export function Dialog({
  open,
  onClose,
  children,
  className,
  dismissOnBackdropClick = true,
  ariaLabel,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-label={ariaLabel}
      onClick={(e) => {
        if (!dismissOnBackdropClick) return;
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        'rounded-lg border border-border-default bg-overlay text-overlay-foreground',
        'w-full max-w-md p-0 shadow-md backdrop:bg-black/60',
        'open:animate-[dialog-in_150ms_cubic-bezier(0.16,1,0.3,1)]',
        className,
      )}
    >
      {children}
    </dialog>
  );
}

export function DialogHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-1 border-b border-border-default px-4 py-3', className)}
      {...rest}
    />
  );
}

export function DialogTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-base font-semibold tracking-tight', className)} {...rest} />;
}

export function DialogBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-3 text-sm', className)} {...rest} />;
}

export function DialogFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border-default px-4 py-3',
        className,
      )}
      {...rest}
    />
  );
}
