'use client';

/**
 * Narrowing a list.
 *
 * - `Segmented` — one choice among a few that exclude each other (a period:
 *   Today · Yesterday · 7 days; a view: Available to you · Run freely · Ask
 *   first). The chosen one is filled with ink.
 * - `FilterChips` — facets that add up; each chip is on or off, and may carry
 *   a count. Off is the quiet state.
 * - `SearchField` — a text filter with the search icon; `name` makes it a
 *   plain GET field of a form.
 *
 * Each option is either a link (`href`: the filter lives in the URL, the
 * server renders the result — the default for a page) or a button (the
 * caller's state, through `onChange` / `onToggle`).
 */
import Link from 'next/link';
import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';
import { formatNumber } from '@/lib/vocabulary';

import { Icon } from './Icon.tsx';

/** shadcn/ui's ToggleGroup look: the chosen segment is the ink, not a colour. */
const SEGMENT =
  'inline-flex h-6 items-center whitespace-nowrap rounded-sm px-2.5 text-caption hover:no-underline';
/** A filter not applied is dashed; applied, the ink twice. */
const CHIP =
  'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-small hover:no-underline';

export interface FilterOption<Value extends string = string> {
  readonly value: Value;
  readonly label: React.ReactNode;
  /** The URL that applies this option; without it the option is a button. */
  readonly href?: string;
  /** How many rows the option holds. */
  readonly count?: number;
}

export function Segmented<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** Names the group for assistive technology ("Period"). */
  label: string;
  options: readonly FilterOption<Value>[];
  value: Value;
  onChange?: (value: Value) => void;
}) {
  return (
    <div
      className="inline-flex gap-0.5 rounded-md border border-border-strong bg-card p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const on = option.value === value;
        const classes = cn(
          SEGMENT,
          on
            ? 'bg-foreground text-background hover:bg-foreground'
            : 'text-muted-foreground hover:bg-muted',
        );
        return option.href ? (
          <Link
            key={option.value}
            href={option.href}
            className={classes}
            aria-current={on ? 'true' : undefined}
          >
            {option.label}
          </Link>
        ) : (
          <button
            key={option.value}
            type="button"
            className={classes}
            aria-pressed={on}
            onClick={() => onChange?.(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function FilterChips<Value extends string>({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: readonly FilterOption<Value>[];
  selected: readonly Value[];
  onToggle?: (value: Value) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      {options.map((option) => {
        const on = selected.includes(option.value);
        const classes = cn(
          CHIP,
          on
            ? 'border-foreground bg-card text-foreground shadow-[inset_0_0_0_1px_var(--foreground)]'
            : 'border-dashed border-border-strong bg-transparent text-muted-foreground hover:border-solid hover:text-foreground',
        );
        const content = (
          <>
            {option.label}
            {option.count !== undefined && (
              <span className="text-caption tabular-nums text-muted-foreground">
                {formatNumber(option.count)}
              </span>
            )}
          </>
        );
        return option.href ? (
          <Link
            key={option.value}
            href={option.href}
            className={classes}
            aria-current={on ? 'true' : undefined}
          >
            {content}
          </Link>
        ) : (
          <button
            key={option.value}
            type="button"
            className={classes}
            aria-pressed={on}
            onClick={() => onToggle?.(option.value)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Names the field ("Filter by tool or resource"); also its placeholder unless one is given. */
  label: string;
  /** A keyboard hint drawn at the end ("/"), when the page binds one. */
  shortcut?: string;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { label, shortcut, className, placeholder, ...rest }: SearchFieldProps,
  ref,
) {
  return (
    <span
      className={cn(
        'inline-flex h-8 min-w-40 items-center gap-2 rounded-md border border-transparent bg-muted px-[9px] text-small text-muted-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
        className,
      )}
    >
      <Icon name="search" size={13} className="flex-none" />
      <input
        ref={ref}
        type="search"
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-small text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
        aria-label={label}
        placeholder={placeholder ?? label}
        {...rest}
      />
      {shortcut && (
        <kbd
          className="flex-none rounded-sm border border-border-strong px-1 text-caption leading-4 text-muted-foreground"
          aria-hidden="true"
        >
          {shortcut}
        </kbd>
      )}
    </span>
  );
});
