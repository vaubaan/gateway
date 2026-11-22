'use client';

/**
 * Dialogs. A dialog asks one question, **states the consequence before
 * anything happens**, and offers the action and a way out. A confirmation is
 * asked only before an act that deletes or stops something for good (spec
 * §4.2); creating, editing and reversible switches act at once.
 *
 * - `Dialog` — the modal surface: shadcn/ui's Dialog on Radix (ADR
 *   design-system-on-shadcn-shared-by-the-app-and-the-site), so focus stays
 *   inside it, Escape closes it, focus returns to where it was, and the page
 *   behind is inert. Labelled by its title, described by its consequence. It
 *   is drawn in a portal on the body, or on the themed island it sits in (the
 *   gallery draws a dark one), so it takes that island's theme.
 * - `ConfirmDialog` — the question in full: title, consequence, optionally a
 *   choice between ways of doing it (`OptionCard`s — "stop the key now" or
 *   "keep it one hour"), the confirming button named after the act, Cancel,
 *   and a quiet hint ("Recorded in the activity, like every change").
 * - `DangerConfirm` — for the acts that cannot be undone: the person types a
 *   phrase before the button enables.
 * - `DialogPanel` — the inside of a dialog, without the modal behaviour (the
 *   gallery, a static preview).
 *
 * A side sheet that stays open is not provided: a region that is always open
 * is a region that always competes.
 */
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { ACTIONS } from '@/lib/vocabulary';

import { Button } from './Button.tsx';
import { Input } from './Input.tsx';

export type DialogWidth = 'md' | 'lg';

export function DialogPanel({
  title,
  titleId,
  description,
  descriptionId,
  children,
  footer,
  hint,
  divided = false,
}: {
  title: React.ReactNode;
  titleId?: string;
  /** The consequence, in a sentence or two, right under the title. */
  description?: React.ReactNode;
  descriptionId?: string;
  children?: React.ReactNode;
  /** The buttons: the action first, then Cancel. */
  footer?: React.ReactNode;
  /** A quiet sentence at the end of the footer. */
  hint?: React.ReactNode;
  /** A hairline under the head, when the body is a long list that scrolls. */
  divided?: boolean;
}) {
  return (
    <>
      <div className={cn('flex-none px-5 pt-4 pb-3', divided && 'border-b border-border')}>
        <h2 className="m-0 text-body leading-snug font-semibold" id={titleId}>
          {title}
        </h2>
        {description && (
          <div className="mt-1.5 text-body text-muted-foreground" id={descriptionId}>
            {description}
          </div>
        )}
      </div>
      {children && (
        <div className={cn('min-h-0 overflow-y-auto px-5 pb-3.5 text-body', divided && 'pt-3.5')}>
          {children}
        </div>
      )}
      {(footer || hint) && (
        <div className="flex flex-none items-center gap-2.5 border-t border-border bg-sidebar px-5 py-3 max-[720px]:flex-wrap">
          {footer}
          {hint && (
            <span className="ml-auto text-right text-caption leading-[1.35] text-muted-foreground">
              {hint}
            </span>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Where a dialog's portal goes: the themed island the dialog sits in (a part of
 * the page drawn in the other theme), else the body.
 */
function useIslandContainer(): [React.RefObject<HTMLSpanElement | null>, HTMLElement | null] {
  const anchor = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const island = anchor.current?.closest<HTMLElement>('[data-theme]');
    setContainer(island && island !== document.documentElement ? island : document.body);
  }, []);
  return [anchor, container];
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  hint,
  width = 'md',
  divided = false,
  dismissible = true,
  testId,
}: {
  open: boolean;
  /** Escape, a click on the backdrop, or Cancel. Not called while `dismissible` is false. */
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  hint?: React.ReactNode;
  width?: DialogWidth;
  divided?: boolean;
  /** `false` while the action is under way: the dialog stays until it has answered. */
  dismissible?: boolean;
  testId?: string;
}) {
  const [anchor, container] = useIslandContainer();
  return (
    <>
      <span ref={anchor} hidden />
      <DialogPrimitive.Root
        open={open && container !== null}
        onOpenChange={(next) => {
          // Escape or the backdrop: the page decides (the state is the caller's).
          if (!next && dismissible) onClose();
        }}
      >
        <DialogPrimitive.Portal container={container}>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim/40 dark:bg-scrim/60" />
          <DialogPrimitive.Content
            data-testid={testId}
            // Without a consequence there is nothing to describe it by (Radix asks to say so).
            {...(description ? {} : { 'aria-describedby': undefined })}
            className={cn(
              // Never taller than the window: the top margin and the same room under it are
              // taken off the height, and the body scrolls between a head and a foot that
              // stay in view. `--dialog-top` is the one number both use.
              'fixed top-(--dialog-top) left-1/2 z-50 flex max-h-[calc(100dvh-var(--dialog-top)-var(--dialog-bottom))] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-lg bg-card text-foreground shadow-lg outline-none',
              '[--dialog-bottom:1.5rem] [@media(max-height:820px)]:[--dialog-top:1.5rem] max-[720px]:[--dialog-bottom:1rem] max-[720px]:[--dialog-top:1rem]',
              width === 'lg' ? 'w-[640px] [--dialog-top:60px]' : 'w-[520px] [--dialog-top:96px]',
            )}
          >
            <DialogPanel
              title={
                <DialogPrimitive.Title asChild>
                  <span>{title}</span>
                </DialogPrimitive.Title>
              }
              description={
                description ? (
                  <DialogPrimitive.Description asChild>
                    <div>{description}</div>
                  </DialogPrimitive.Description>
                ) : undefined
              }
              footer={footer}
              hint={hint}
              divided={divided}
            >
              {children}
            </DialogPanel>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

/** One way of doing the thing, among two or three: a radio with its consequence under it. */
export function OptionCard({
  name,
  value,
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  label: React.ReactNode;
  /** What choosing it does, in a sentence. */
  description?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-body has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
        checked && 'border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]',
      )}
      data-checked={checked || undefined}
    >
      <input
        type="radio"
        className="mt-0.5 size-[15px] flex-none accent-primary focus-visible:outline-none"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span>
        <span className="block">{label}</span>
        {description && <span className="mt-px block text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}

export interface ConfirmOption {
  readonly value: string;
  readonly label: React.ReactNode;
  readonly description?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  consequence,
  options,
  value,
  onChange,
  confirmLabel,
  tone = 'primary',
  busy = false,
  error = null,
  hint,
  onConfirm,
  onCancel,
  children,
  testId,
}: {
  open: boolean;
  /** The question: "Replace your key?" */
  title: React.ReactNode;
  /** What changes and what does not, before anything happens. Required. */
  consequence: React.ReactNode;
  /** Two or three ways of doing it, each with its own consequence. */
  options?: readonly ConfirmOption[];
  value?: string;
  onChange?: (value: string) => void;
  /** The act, as a verb: "Replace key". Never "OK". */
  confirmLabel: string;
  /** `danger` for an act that stops or destroys something. */
  tone?: 'primary' | 'danger';
  busy?: boolean;
  error?: string | null;
  hint?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
  testId?: string;
}) {
  const group = useId();
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={consequence}
      dismissible={!busy}
      hint={hint}
      testId={testId}
      footer={
        <>
          <Button
            type="button"
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            {ACTIONS.cancel}
          </Button>
        </>
      }
    >
      {options && options.length > 0 && (
        <div role="radiogroup" aria-label="How" className="grid gap-2">
          {options.map((option) => (
            <OptionCard
              key={option.value}
              name={group}
              value={option.value}
              checked={option.value === value}
              onChange={(next) => onChange?.(next)}
              label={option.label}
              description={option.description}
              disabled={busy}
            />
          ))}
        </div>
      )}
      {children}
      {error && <DialogError>{error}</DialogError>}
    </Dialog>
  );
}

function DialogError({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 mb-0 text-body font-medium text-foreground" role="alert">
      {children}
    </p>
  );
}

/**
 * Type-to-confirm, for the acts that cannot be undone (stop a mission for
 * good, disconnect an account). Render conditionally:
 * `{open && <DangerConfirm … />}`.
 */
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
  /** What is lost, and what stops. */
  body: React.ReactNode;
  /** What the person types, exactly. */
  phrase: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [value, setValue] = useState('');
  const inputId = useId();
  const matches = value === phrase;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      description={body}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="danger" onClick={onConfirm} disabled={busy || !matches}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            {ACTIONS.cancel}
          </Button>
        </>
      }
    >
      <label className="mb-1.5 block text-muted-foreground" htmlFor={inputId}>
        Type <code>{phrase}</code> to confirm:
      </label>
      <Input
        id={inputId}
        aria-label={`Type ${phrase} to confirm`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        mono
      />
      {error && <DialogError>{error}</DialogError>}
    </Dialog>
  );
}
