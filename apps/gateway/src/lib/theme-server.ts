/**
 * The theme of the request, read from its cookie (`lib/theme.ts`). Used by the
 * root layout, which writes it on `<html>`, and by the shell, which hands it
 * to the toggle so that server and browser render the same control.
 *
 * Read from the `cookie` header, like the session helpers read theirs: one
 * way into the request for every server component.
 */
import { headers } from 'next/headers';

import { parseTheme, THEME_COOKIE, type ThemeChoice } from './theme';

/** The value of one cookie of a `cookie` header, or `null`. */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export async function currentTheme(): Promise<ThemeChoice> {
  return parseTheme(cookieValue((await headers()).get('cookie'), THEME_COOKIE));
}
