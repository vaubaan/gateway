import { forwardRef } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { cn } from './cn';

const BASE =
  'block w-full rounded-sm border bg-surface px-2.5 py-1.5 text-sm text-foreground placeholder:text-subtle ' +
  'transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const STATE_NORMAL = 'border-border-default hover:border-border-strong';
const STATE_ERROR = 'border-danger-foreground';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { error, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={error || undefined}
      className={cn(BASE, error ? STATE_ERROR : STATE_NORMAL, className)}
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { error, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={error || undefined}
      className={cn(BASE, 'resize-y', error ? STATE_ERROR : STATE_NORMAL, className)}
      {...rest}
    />
  );
});
