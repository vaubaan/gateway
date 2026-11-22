'use client';

/**
 * The theme, in three states: System, Light, Dark.
 *
 * - `ThemeToggle` — the one icon button at the bottom of the side navigation:
 *   it shows the current choice and a press moves to the next one.
 * - `ThemeChoiceControl` — the same choice as three named options (Settings).
 *
 * Both read and write the same thing: the `data-theme` attribute of `<html>`
 * (absent for System) and the cookie that makes the server render it
 * (`lib/theme.ts`). The attribute is the store — two controls on one page
 * stay in step, and nothing flashes at load because the server already wrote
 * it.
 */
import { useCallback, useSyncExternalStore } from 'react';

import { Icon, Segmented, type IconName } from '@/components/ui';
import {
  nextTheme,
  parseTheme,
  THEME_CHOICES,
  themeAttribute,
  themeCookie,
  type ThemeChoice,
} from '@/lib/theme';
import { THEME_WORDS } from '@/lib/vocabulary';

import styles from './shell.styles';

const ICONS: Readonly<Record<ThemeChoice, IconName>> = {
  system: 'system',
  light: 'sun',
  dark: 'moon',
};

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function readChoice(): ThemeChoice {
  return parseTheme(document.documentElement.getAttribute('data-theme'));
}

function applyChoice(choice: ThemeChoice): void {
  const attribute = themeAttribute(choice);
  if (attribute) document.documentElement.setAttribute('data-theme', attribute);
  else document.documentElement.removeAttribute('data-theme');
  document.cookie = themeCookie(choice, window.location.protocol === 'https:');
}

/** The current choice and how to change it. `initial` is what the server rendered. */
export function useTheme(
  initial: ThemeChoice,
): readonly [ThemeChoice, (next: ThemeChoice) => void] {
  const choice = useSyncExternalStore(subscribe, readChoice, () => initial);
  const set = useCallback((next: ThemeChoice) => applyChoice(next), []);
  return [choice, set];
}

export function ThemeToggle({ initial }: { initial: ThemeChoice }) {
  const [choice, setChoice] = useTheme(initial);
  const next = nextTheme(choice);
  const label = `${THEME_WORDS.label}: ${THEME_WORDS[choice]}. Switch to ${THEME_WORDS[next]}.`;
  return (
    <button
      type="button"
      className={styles.themeToggle}
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      data-theme-choice={choice}
      onClick={() => setChoice(next)}
    >
      <Icon name={ICONS[choice]} size={14} />
    </button>
  );
}

export function ThemeChoiceControl({ initial }: { initial: ThemeChoice }) {
  const [choice, setChoice] = useTheme(initial);
  return (
    <Segmented
      label={THEME_WORDS.label}
      value={choice}
      onChange={setChoice}
      options={THEME_CHOICES.map((value) => ({ value, label: THEME_WORDS[value] }))}
    />
  );
}
