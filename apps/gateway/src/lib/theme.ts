/**
 * The theme a person chose: `system` (follow the device), `light` or `dark`.
 *
 * The choice is kept in a cookie, not in `localStorage`, so that the server
 * renders `<html data-theme>` itself: the first paint is already in the right
 * theme, with no inline script and no flash. `system` is the absence of the
 * cookie and of the attribute; the style sheet then follows
 * `prefers-color-scheme` (`styles/tokens.css`).
 *
 * The cookie is a display preference and nothing else: it is not `HttpOnly`
 * (the toggle writes it), it carries no identity, and the server reads it
 * through `parseTheme`, which accepts the two known values only.
 *
 * Pure and browser-safe.
 */

export const THEME_COOKIE = 'vaubaan_theme';

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
/** What the document carries: a chosen theme, or nothing for `system`. */
export type ChosenTheme = Exclude<ThemeChoice, 'system'>;

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** A cookie value (or anything else) as a choice; unknown values are `system`. */
export function parseTheme(raw: string | null | undefined): ThemeChoice {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** The `data-theme` attribute of `<html>` for a choice: absent for `system`. */
export function themeAttribute(choice: ThemeChoice): ChosenTheme | undefined {
  return choice === 'system' ? undefined : choice;
}

/** The next choice when the one toggle of the shell is pressed. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  const index = THEME_CHOICES.indexOf(choice);
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length] ?? 'system';
}

/** The `document.cookie` assignment that remembers a choice (`system` forgets it). */
export function themeCookie(choice: ThemeChoice, secure: boolean): string {
  const attributes = `Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  if (choice === 'system') return `${THEME_COOKIE}=; ${attributes}; Max-Age=0`;
  return `${THEME_COOKIE}=${choice}; ${attributes}; Max-Age=${ONE_YEAR_SECONDS}`;
}
