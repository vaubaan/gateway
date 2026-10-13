import {
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
  useId,
} from 'react';
import styles from './Input.module.css';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest }: InputProps,
  ref,
) {
  return (
    <input
      ref={ref}
      className={[styles.field, className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    />
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest }: TextareaProps,
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={[styles.field, styles.textarea, className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    />
  );
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...rest }: SelectProps,
  ref,
) {
  return (
    <select
      ref={ref}
      className={[styles.field, styles.select, className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </select>
  );
});

/**
 * A labelled form field. With `htmlFor` (the `id` of the one control inside)
 * the label is a real `<label>` bound to that control, so clicking it focuses
 * the control and assistive technology announces it. Without it — a field
 * that groups several controls — the wrapper is a `group` named by the label,
 * and each control carries its own `aria-label`.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label?: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
}) {
  const labelId = useId();
  const grouped = label !== undefined && label !== null && htmlFor === undefined;
  return (
    <div
      className={styles.fieldGroup}
      role={grouped ? 'group' : undefined}
      aria-labelledby={grouped ? labelId : undefined}
    >
      {label &&
        (htmlFor ? (
          <label className={styles.label} htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <div className={styles.label} id={labelId}>
            {label}
          </div>
        ))}
      {children}
      {hint && !error && <div className={styles.hint}>{hint}</div>}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
