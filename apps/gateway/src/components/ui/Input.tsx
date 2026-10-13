/**
 * Form controls, and the field that labels them.
 *
 * A field **says the shape it expects before the person types**, in its label
 * ("Restricted key · starts with `rk_test_` or `rk_live_`, 32 characters or
 * more"), and says it again in the error, beside the control, with what to do
 * ("This is a secret key. Create a restricted key at…"). A required field is
 * visibly required; an optional one says "optional". An input has no success
 * state: the absence of an error is enough.
 *
 * - `Field` — label, expected shape, hint, inline error; binds them to its
 *   control (`for`, `aria-describedby`, `aria-invalid`).
 * - `Input`, `Textarea`, `Select` — the text controls (`size="sm"` inside a
 *   table row, `mono` for an identifier or a secret).
 * - `Checkbox`, `Radio`, `Switch` — native inputs with their words beside
 *   them. A `Switch` is labelled by what happens ("Ask me first").
 */
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

import styles from './Input.module.css';

type ControlSize = 'sm' | 'md';

function controlClasses(
  size: ControlSize,
  mono: boolean | undefined,
  extra: readonly (string | undefined)[],
): string {
  return [styles.control, size === 'sm' ? styles.sm : '', mono ? styles.mono : '', ...extra]
    .filter(Boolean)
    .join(' ');
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ControlSize;
  /** An identifier, a key, a figure: the monospace face. */
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = 'md', mono, ...rest }: InputProps,
  ref,
) {
  return <input ref={ref} className={controlClasses(size, mono, [className])} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, mono, ...rest }: TextareaProps,
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={controlClasses('md', mono, [styles.textarea, className])}
      {...rest}
    />
  );
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: ControlSize;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size = 'md', children, ...rest }: SelectProps,
  ref,
) {
  return (
    <select ref={ref} className={controlClasses(size, false, [styles.select, className])} {...rest}>
      {children}
    </select>
  );
});

type ChoiceProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> & {
  /** The words beside the box. Without them, pass `aria-label`. */
  children?: React.ReactNode;
};

export const Checkbox = forwardRef<HTMLInputElement, ChoiceProps>(function Checkbox(
  { className, children, ...rest }: ChoiceProps,
  ref,
) {
  const box = <input ref={ref} type="checkbox" className={styles.box} {...rest} />;
  if (children === undefined) return box;
  return (
    <label className={[styles.choice, className ?? ''].join(' ')}>
      {box}
      <span>{children}</span>
    </label>
  );
});

export const Radio = forwardRef<HTMLInputElement, ChoiceProps>(function Radio(
  { className, children, ...rest }: ChoiceProps,
  ref,
) {
  const box = <input ref={ref} type="radio" className={styles.box} {...rest} />;
  if (children === undefined) return box;
  return (
    <label className={[styles.choice, className ?? ''].join(' ')}>
      {box}
      <span>{children}</span>
    </label>
  );
});

/**
 * On or off, taking effect at once. Amber when on: in this interface a switch
 * turns "ask me first" on, which is the exception worth seeing.
 */
export const Switch = forwardRef<HTMLInputElement, ChoiceProps>(function Switch(
  { className, children, ...rest }: ChoiceProps,
  ref,
) {
  const control = (
    <input ref={ref} type="checkbox" role="switch" className={styles.switch} {...rest} />
  );
  if (children === undefined) return control;
  return (
    <label className={[styles.choice, className ?? ''].join(' ')}>
      {control}
      <span>{children}</span>
    </label>
  );
});

/**
 * A labelled form field. With `htmlFor` (the `id` of the one control inside)
 * the label is a real `<label>` bound to that control, the hint and the error
 * are announced with it, and an error marks it invalid. Without it — a field
 * that groups several controls — the wrapper is a `group` named by the label,
 * and each control carries its own `aria-label`.
 */
export function Field({
  label,
  htmlFor,
  shape,
  optional = false,
  hint,
  error,
  children,
}: {
  label?: React.ReactNode;
  htmlFor?: string;
  /** The expected shape, said in the label: "starts with `rk_`, 32 characters or more". */
  shape?: React.ReactNode;
  /** Says "optional" after the label. A field is required unless it says so. */
  optional?: boolean;
  hint?: React.ReactNode;
  /** What is wrong and what to do; replaces the hint. */
  error?: React.ReactNode;
  children: React.ReactNode;
}) {
  const labelId = useId();
  const noteId = useId();
  const grouped = label !== undefined && label !== null && htmlFor === undefined;
  const hasNote = Boolean(error) || Boolean(hint);
  const labelText = (
    <>
      {label}
      {shape && <span className={styles.shape}> · {shape}</span>}
      {optional && <span className={styles.shape}> · optional</span>}
    </>
  );
  // The one control of the field is told about its note and its state.
  const control =
    htmlFor && isValidElement<Record<string, unknown>>(children)
      ? cloneElement(children, {
          'aria-describedby':
            [children.props['aria-describedby'], hasNote ? noteId : null]
              .filter(Boolean)
              .join(' ') || undefined,
          'aria-invalid': error ? true : children.props['aria-invalid'],
        })
      : children;
  return (
    <div
      className={styles.field}
      role={grouped ? 'group' : undefined}
      aria-labelledby={grouped ? labelId : undefined}
    >
      {label &&
        (htmlFor ? (
          <label className={styles.label} htmlFor={htmlFor}>
            {labelText}
          </label>
        ) : (
          <div className={styles.label} id={labelId}>
            {labelText}
          </div>
        ))}
      {control}
      {hint && !error && (
        <div className={styles.hint} id={noteId}>
          {hint}
        </div>
      )}
      {error && (
        <div className={styles.error} id={noteId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
