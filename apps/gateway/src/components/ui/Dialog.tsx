'use client';

/**
 * Dialogs. A dialog asks one question, **states the consequence before
 * anything happens**, and offers the action and a way out.
 *
 * - `Dialog` — the modal surface: a native `<dialog>` opened with
 *   `showModal()`, so the browser keeps focus inside it, closes it on Escape
 *   and makes the page behind inert. Labelled by its title, described by its
 *   consequence.
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
import { useEffect, useId, useRef, useState } from 'react';

import { ACTIONS } from '@/lib/vocabulary';

import { Button } from './Button.tsx';
import styles from './Dialog.module.css';
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
      <div className={[styles.head, divided ? styles.headDivided : ''].join(' ')}>
        <h2 className={styles.title} id={titleId}>
          {title}
        </h2>
        {description && (
          <div className={styles.description} id={descriptionId}>
            {description}
          </div>
        )}
      </div>
      {children && (
        <div className={[styles.body, divided ? styles.bodyDivided : ''].join(' ')}>{children}</div>
      )}
      {(footer || hint) && (
        <div className={styles.foot}>
          {footer}
          {hint && <span className={styles.hint}>{hint}</span>}
        </div>
      )}
    </>
  );
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
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={[styles.dialog, width === 'lg' ? styles.wide : ''].join(' ')}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-testid={testId}
      onCancel={(event) => {
        // Escape: the page decides (the state is the caller's), never the element alone.
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      {open && (
        <DialogPanel
          title={title}
          titleId={titleId}
          description={description}
          descriptionId={descriptionId}
          footer={footer}
          hint={hint}
          divided={divided}
        >
          {children}
        </DialogPanel>
      )}
    </dialog>
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
    <label className={[styles.option, checked ? styles.optionOn : ''].join(' ')}>
      <input
        type="radio"
        className={styles.optionInput}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span>
        <span className={styles.optionLabel}>{label}</span>
        {description && <span className={styles.optionDescription}>{description}</span>}
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
        <div role="radiogroup" aria-label="How" className={styles.options}>
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
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
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
      <label className={styles.phraseLabel} htmlFor={inputId}>
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
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
