import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { THEME_COOKIE } from '../../lib/theme';
import {
  DOCUMENT_STYLE,
  DOCUMENT_THEME_COOKIE,
  DOCUMENT_TOKENS,
  documentThemeOf,
  htmlDocument,
  messageDocument,
} from './document';

const TOKENS_CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../styles/tokens.css'),
  'utf8',
);

/** The declarations of one block of the token sheet, by the selector that opens it. */
function blockOf(selector: string): Map<string, string> {
  const start = TOKENS_CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block ${selector} in tokens.css`);
  const body = TOKENS_CSS.slice(start, TOKENS_CSS.indexOf('}', start));
  const values = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    values.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return values;
}

describe('the self-contained document', () => {
  it('repeats the tokens of the interface value for value, in both themes', () => {
    const sheet = { light: blockOf("[data-theme='light']"), dark: blockOf("[data-theme='dark']") };
    for (const theme of ['light', 'dark'] as const) {
      const tokens = Object.entries(DOCUMENT_TOKENS[theme]);
      expect(tokens.length).toBeGreaterThan(8);
      for (const [name, value] of tokens) {
        expect(`${theme} ${name}: ${sheet[theme].get(name)}`).toBe(`${theme} ${name}: ${value}`);
      }
    }
    // The two themes declare the same names: a token cannot be missing in one.
    expect(Object.keys(DOCUMENT_TOKENS.dark)).toEqual(Object.keys(DOCUMENT_TOKENS.light));
  });

  it('uses no colour that is not one of those tokens', () => {
    const declared = new Set(
      [...Object.values(DOCUMENT_TOKENS.light), ...Object.values(DOCUMENT_TOKENS.dark)].map((v) =>
        v.toLowerCase(),
      ),
    );
    for (const colour of DOCUMENT_STYLE.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) {
      expect(declared.has(colour.toLowerCase()), colour).toBe(true);
    }
    expect(DOCUMENT_STYLE).not.toMatch(/rgb\(|hsl\(/);
  });

  it('is light by default, dark for a system that asks for it, and the chosen theme when given', () => {
    expect(DOCUMENT_STYLE).toContain('prefers-color-scheme: dark');
    expect(DOCUMENT_STYLE).toContain(':root:not([data-theme])');
    expect(htmlDocument({ title: 't', body: '' })).toContain('<html lang="en">');
    expect(htmlDocument({ title: 't', body: '', theme: 'dark' })).toContain(
      '<html lang="en" data-theme="dark">',
    );
    expect(htmlDocument({ title: 't', body: '', theme: 'light' })).toContain('data-theme="light"');
  });

  it('reads the chosen theme from the cookie of the application, and nothing else', () => {
    expect(DOCUMENT_THEME_COOKIE).toBe(THEME_COOKIE);
    const headers = (cookie?: string) => new Headers(cookie ? { cookie } : {});
    expect(documentThemeOf(headers())).toBeNull();
    expect(documentThemeOf(headers('vaubaan_session=abc'))).toBeNull();
    expect(documentThemeOf(headers('a=1; vaubaan_theme=dark; b=2'))).toBe('dark');
    expect(documentThemeOf(headers('vaubaan_theme=light'))).toBe('light');
    expect(documentThemeOf(headers('vaubaan_theme="><script>'))).toBeNull();
  });

  it('carries no script and no external resource, and escapes its title and its message', () => {
    const html = messageDocument({ title: 'Not <yours>', message: 'Ask "them" & wait.' });
    expect(html).toContain('<h1>Not &lt;yours&gt;</h1>');
    expect(html).toContain('<title>Not &lt;yours&gt;</title>');
    expect(html).toContain('Ask &quot;them&quot; &amp; wait.');
    expect(html).not.toMatch(/<script|<link|<img|src=|url\(/);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it('puts the nonce on its one style element when the policy asks for one', () => {
    expect(htmlDocument({ title: 't', body: '', nonce: 'abc123' })).toContain(
      '<style nonce="abc123">',
    );
    expect(htmlDocument({ title: 't', body: '' })).toContain('<style>');
  });
});
