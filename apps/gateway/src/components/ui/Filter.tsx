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

import { formatNumber } from '@/lib/vocabulary';

import styles from './Filter.module.css';
import { Icon } from './Icon.tsx';

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
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => {
        const on = option.value === value;
        const classes = [styles.segment, on ? styles.segmentOn : ''].join(' ');
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
    <div className={styles.chips} role="group" aria-label={label}>
      {options.map((option) => {
        const on = selected.includes(option.value);
        const classes = [styles.chip, on ? styles.chipOn : ''].join(' ');
        const content = (
          <>
            {option.label}
            {option.count !== undefined && (
              <span className={styles.chipCount}>{formatNumber(option.count)}</span>
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
    <span className={[styles.search, className ?? ''].join(' ')}>
      <Icon name="search" size={13} className={styles.searchIcon} />
      <input
        ref={ref}
        type="search"
        className={styles.searchInput}
        aria-label={label}
        placeholder={placeholder ?? label}
        {...rest}
      />
      {shortcut && (
        <kbd className={styles.kbd} aria-hidden="true">
          {shortcut}
        </kbd>
      )}
    </span>
  );
});
