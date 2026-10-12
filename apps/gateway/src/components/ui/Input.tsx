import {
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
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

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label className={styles.label} htmlFor={htmlFor}>
      {children}
    </label>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.fieldGroup}>
      {label && <div className={styles.label}>{label}</div>}
      {children}
      {hint && !error && <div className={styles.hint}>{hint}</div>}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
