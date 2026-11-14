/**
 * A self-contained HTML document: the pages a handler answers itself, before
 * any application shell exists and under a policy that loads nothing — the
 * refusals of the forwarded request URL (`requests/handlers.ts`).
 *
 * They cannot read the style sheet of the application, so the few tokens they
 * need are repeated here, value for value (`DOCUMENT_TOKENS`); a test keeps
 * them equal to `styles/tokens.css`. Light by default, dark when the system
 * asks for it, and the theme the person chose in the application when the
 * request carries its cookie — the document arrives in the right theme, with
 * no script.
 *
 * Host-agnostic and pure: strings in, a string out. The caller escapes what it
 * puts in `body` (`escapeHtml`) and owns the response headers.
 */

export type DocumentTheme = 'light' | 'dark';

/** The cookie the application keeps the chosen theme in (`lib/theme.ts`, `THEME_COOKIE`). */
export const DOCUMENT_THEME_COOKIE = 'vaubaan_theme';

/** The tokens a document uses, by theme. Names and values are those of `styles/tokens.css`. */
export const DOCUMENT_TOKENS: Readonly<Record<DocumentTheme, Readonly<Record<string, string>>>> = {
  light: {
    '--paper': '#ffffff',
    '--paper-side': '#f8fafc',
    '--fill': '#f1f5f9',
    '--line': '#e2e8f0',
    '--line-strong': '#cbd5e1',
    '--ink': '#0f172a',
    '--ink-2': '#334155',
    '--ink-3': '#475569',
    '--accent': '#0369a1',
    '--accent-ink': '#075985',
    '--on-accent': '#ffffff',
    '--warn': '#b45309',
    '--warn-soft': '#fffbeb',
    '--warn-line': '#fde68a',
  },
  dark: {
    '--paper': '#020817',
    '--paper-side': '#0f172a',
    '--fill': '#1e293b',
    '--line': '#1e293b',
    '--line-strong': '#334155',
    '--ink': '#f8fafc',
    '--ink-2': '#cbd5e1',
    '--ink-3': '#94a3b8',
    '--accent': '#38bdf8',
    '--accent-ink': '#7dd3fc',
    '--on-accent': '#020817',
    '--warn': '#fbbf24',
    '--warn-soft': '#422006',
    '--warn-line': '#92400e',
  },
};

function declarations(theme: DocumentTheme): string {
  return Object.entries(DOCUMENT_TOKENS[theme])
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
}

/**
 * The style sheet of a document: the tokens in both themes, then the same
 * rhythm as a page outside the shell (`components/auth/AuthPage`) — one narrow
 * column, the brand, a title, a sentence. Four text sizes, two weights.
 */
export const DOCUMENT_STYLE = `
:root { color-scheme: light; ${declarations('light')} }
:root[data-theme='dark'] { color-scheme: dark; ${declarations('dark')} }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { color-scheme: dark; ${declarations('dark')} } }
* { box-sizing: border-box; }
html { background: var(--paper); }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; font-size: 0.875rem; line-height: 1.5; -webkit-font-smoothing: antialiased; }
main { flex: 1; width: 100%; max-width: 34rem; margin: 0 auto; padding: 12vh 1.5rem 3rem; }
.brand { display: flex; align-items: center; gap: 9px; margin-bottom: 2rem; font-weight: 600; }
.mark { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; background: var(--ink); color: var(--paper); font-size: 0.8125rem; line-height: 1; }
h1 { margin: 0 0 0.25rem; font-size: 1.25rem; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; overflow-wrap: anywhere; }
h2 { margin: 1.5rem 0 0.25rem; font-size: 0.875rem; font-weight: 600; }
p { margin: 0 0 0.75rem; }
.lede { color: var(--ink-3); font-size: 0.8125rem; }
ul { margin: 0 0 0.75rem; padding-left: 1.25rem; color: var(--ink-2); font-size: 0.8125rem; }
li { margin: 0.125rem 0; }
dl { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.5rem 1.125rem; font-size: 0.8125rem; }
dt { color: var(--ink-3); }
dd { margin: 0; overflow-wrap: anywhere; }
code { padding: 1px 5px; border-radius: 4px; background: var(--fill); font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 0.93em; }
strong { font-weight: 600; }
.facts { margin: 1.25rem 0 0; padding: 0.875rem 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.box { margin: 1rem 0 0; padding: 0.75rem 0.875rem; border: 1px solid var(--warn-line); border-radius: 10px; background: var(--warn-soft); }
.box dt { color: var(--ink-2); }
.note { margin-top: 0.125rem; color: var(--ink-3); font-size: 0.75rem; }
.box .note { color: var(--ink-2); }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; margin-top: 1.5rem; }
button { min-height: 36px; padding: 0 1rem; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--paper); color: var(--ink); font: inherit; font-weight: 600; cursor: pointer; }
button.primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--paper), 0 0 0 4px var(--accent); }
footer { padding: 1rem 1.5rem; color: var(--ink-3); font-size: 0.75rem; text-align: center; }
@media (max-width: 480px) { dl { grid-template-columns: minmax(0, 1fr); gap: 0.125rem; } dt:not(:first-child) { margin-top: 0.5rem; } }
`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The theme the person chose in the application, from the request's cookies; `null`: follow the system. */
export function documentThemeOf(headers: Headers): DocumentTheme | null {
  const cookies = headers.get('cookie');
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== DOCUMENT_THEME_COOKIE) continue;
    const value = rest.join('=');
    return value === 'light' || value === 'dark' ? value : null;
  }
  return null;
}

export interface DocumentInput {
  /** The `<title>`; escaped here. */
  readonly title: string;
  /** The inside of `<main>`, after the brand; already escaped by the caller. */
  readonly body: string;
  /** After `<main>`: a `<footer>`; already escaped by the caller. */
  readonly footer?: string;
  readonly theme?: DocumentTheme | null;
  /** The nonce of the style element, when the response carries a policy that asks for one. */
  readonly nonce?: string;
}

/** The whole document. No script, no external resource. */
export function htmlDocument(input: DocumentInput): string {
  const theme = input.theme ? ` data-theme="${input.theme}"` : '';
  const nonce = input.nonce ? ` nonce="${escapeHtml(input.nonce)}"` : '';
  return `<!doctype html>
<html lang="en"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(input.title)}</title>
<style${nonce}>${DOCUMENT_STYLE}</style>
</head>
<body><main><div class="brand"><span class="mark" aria-hidden="true">V</span><span>Vaubaan</span></div>${input.body}</main>${input.footer ?? ''}</body>
</html>
`;
}

/** A document with one title and one sentence: the request stops here. */
export function messageDocument(input: {
  readonly title: string;
  readonly message: string;
  readonly footer?: string;
  readonly theme?: DocumentTheme | null;
  readonly nonce?: string;
}): string {
  return htmlDocument({
    title: input.title,
    body: `<h1>${escapeHtml(input.title)}</h1><p class="lede">${escapeHtml(input.message)}</p>`,
    footer: input.footer,
    theme: input.theme,
    nonce: input.nonce,
  });
}
