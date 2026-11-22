/**
 * Form controls, and the field that labels them.
 *
 * A field **says the shape it expects before the person types**, in its label
 * ("Secret key · starts with `sk_test_` or `sk_live_`, 32 characters or
 * more"), and says it again in the error, beside the control, with what to do
 * ("This is a restricted key. Reveal the secret key at…"). A required field is
 * visibly required; an optional one says "optional". An input has no success
 * state: the absence of an error is enough.
 *
 * - `Field` — label, expected shape, hint, inline error; binds them to its
 *   control (`for`, `aria-describedby`, `aria-invalid`).
 * - `Input`, `Textarea`, `Select` — the text controls (`size="sm"` inside a
 *   table row, `mono` for an identifier or a secret).
 * - `Checkbox`, `Radio`, `Switch` — native inputs with their words beside
 *   them. A `Switch` is labelled by what happens ("Ask me first").
 *
 * shadcn/ui's Input, Textarea, Label and Switch, drawn on the shared tokens
 * (ADR design-system-on-shadcn-shared-by-the-app-and-the-site). The controls
 * stay native elements: a server form posts them as they are, and a page's
 * `onChange` keeps its event.
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

import { cn } from '@/lib/utils';

type ControlSize = 'sm' | 'md';

/** The look every text control shares: the boundary at 3:1, a red line and halo when invalid. */
function controlClasses(
  size: ControlSize,
  mono: boolean | undefined,
  ...extra: (string | undefined | false)[]
): string {
  return cn(
    'w-full rounded-md border border-input bg-card text-body leading-normal text-foreground transition-colors placeholder:text-faint hover:enabled:not-focus:border-muted-foreground focus-visible:rounded-md disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-refused aria-invalid:shadow-[0_0_0_2px_var(--refused-bg)]',
    size === 'sm' ? 'h-7 px-[7px]' : 'h-8 px-2.5',
    mono && 'font-mono',
    ...extra,
  );
}

const CHEVRON =
  'appearance-none bg-[linear-gradient(45deg,transparent_50%,var(--muted-foreground)_50%),linear-gradient(135deg,var(--muted-foreground)_50%,transparent_50%)] bg-[length:5px_5px,5px_5px] bg-[position:right_15px_center,right_10px_center] bg-no-repeat';

const CHOICE = 'inline-flex cursor-pointer items-center gap-2 text-body';
const BOX = 'm-0 size-[15px] flex-none cursor-pointer accent-primary disabled:cursor-not-allowed';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ControlSize;
  /** An identifier, a key, a figure: the monospace face. */
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = 'md', mono, ...rest }: InputProps,
  ref,
) {
  return <input ref={ref} className={controlClasses(size, mono, className)} {...rest} />;
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
      className={controlClasses('md', mono, 'h-auto min-h-20 resize-y px-2.5 py-2', className)}
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
    <select
      ref={ref}
      className={controlClasses(size, false, CHEVRON, size === 'sm' ? 'pr-6' : 'pr-8', className)}
      {...rest}
    >
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
  const box = <input ref={ref} type="checkbox" className={BOX} {...rest} />;
  if (children === undefined) return box;
  return (
    <label className={cn(CHOICE, className)}>
      {box}
      <span>{children}</span>
    </label>
  );
});

export const Radio = forwardRef<HTMLInputElement, ChoiceProps>(function Radio(
  { className, children, ...rest }: ChoiceProps,
  ref,
) {
  const box = <input ref={ref} type="radio" className={BOX} {...rest} />;
  if (children === undefined) return box;
  return (
    <label className={cn(CHOICE, className)}>
      {box}
      <span>{children}</span>
    </label>
  );
});

/**
 * On or off, taking effect at once. The accent when on: in this interface a
 * switch turns "ask me first" on, which waits for the person.
 */
export const Switch = forwardRef<HTMLInputElement, ChoiceProps>(function Switch(
  { className, children, ...rest }: ChoiceProps,
  ref,
) {
  const control = (
    <input
      ref={ref}
      type="checkbox"
      role="switch"
      className="relative m-0 h-4 w-7 flex-none cursor-pointer appearance-none rounded-full bg-input transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-background after:transition-transform after:content-[''] checked:bg-primary checked:after:translate-x-3 focus-visible:rounded-full disabled:cursor-not-allowed disabled:opacity-50"
      {...rest}
    />
  );
  if (children === undefined) return control;
  return (
    <label className={cn(CHOICE, className)}>
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
      {shape && <span className="text-muted-foreground"> · {shape}</span>}
      {optional && <span className="text-muted-foreground"> · optional</span>}
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
      className="flex min-w-0 flex-col gap-[5px]"
      role={grouped ? 'group' : undefined}
      aria-labelledby={grouped ? labelId : undefined}
    >
      {label &&
        (htmlFor ? (
          <label className="block text-caption text-muted-foreground" htmlFor={htmlFor}>
            {labelText}
          </label>
        ) : (
          <div className="block text-caption text-muted-foreground" id={labelId}>
            {labelText}
          </div>
        ))}
      {control}
      {hint && !error && (
        <div className="text-caption text-muted-foreground" id={noteId}>
          {hint}
        </div>
      )}
      {error && (
        <div className="text-small text-refused-fg" id={noteId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
