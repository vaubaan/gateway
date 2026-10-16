/**
 * Small, fence-aware Markdown helpers for the build-time generator: read a
 * repository document, take the part the site needs, point its relative links
 * at GitHub, and make it safe for MDX. Pure functions, no IO.
 */
import { posix } from 'node:path';

import { githubBlob } from '../site/constants';

export interface Frontmatter {
  readonly data: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A line, and whether it sits inside a fenced code block (the fence lines included). */
interface Line {
  readonly text: string;
  readonly code: boolean;
}

const FENCE = /^\s*(`{3,}|~{3,})/;

function linesOf(markdown: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  for (const text of markdown.split('\n')) {
    const match = FENCE.exec(text);
    if (fence === null && match?.[1]) {
      fence = match[1];
      out.push({ text, code: true });
    } else if (fence !== null) {
      out.push({ text, code: true });
      if (match?.[1] && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
    } else {
      out.push({ text, code: false });
    }
  }
  return out;
}

/** Applies `edit` to the prose of a Markdown text, leaving fenced code and inline code alone. */
function mapProse(markdown: string, edit: (prose: string) => string): string {
  return linesOf(markdown)
    .map(({ text, code }) => {
      if (code) return text;
      // Split on inline code spans; odd indexes are code.
      return text
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 === 1 ? part : edit(part)))
        .join('');
    })
    .join('\n');
}

/** The `key: value` lines of a leading `---` block (lists and nested keys are skipped). */
export function splitFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined || match[2] === '') continue;
    data[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const after = text.indexOf('\n', end + 1);
  return { data, body: after < 0 ? '' : text.slice(after + 1) };
}

/** The first `# ` heading and the text after it. */
export function splitTitle(body: string): { readonly title: string | null; readonly rest: string } {
  const lines = body.split('\n');
  const index = lines.findIndex((line) => /^# /.test(line));
  if (index < 0) return { title: null, rest: body };
  const title = (lines[index] ?? '').replace(/^# /, '').trim();
  return { title, rest: lines.slice(index + 1).join('\n') };
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/**
 * Points the relative links and anchors of a repository document at the file
 * they name on GitHub: on the site, `../decisions/x.md` or `#tests` would lead
 * nowhere. `sourcePath` is the document's path from the repository root.
 */
export function rewriteRelativeLinks(markdown: string, sourcePath: string): string {
  const dir = posix.dirname(sourcePath);
  return mapProse(markdown, (prose) =>
    prose.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
      if (isExternal(target)) return whole;
      if (target.startsWith('#')) return `](${githubBlob(sourcePath)}${target})`;
      const [path = '', anchor] = target.split('#');
      const resolved = posix.normalize(posix.join(dir, path));
      return `](${githubBlob(resolved)}${anchor ? `#${anchor}` : ''})`;
    }),
  );
}

/**
 * Makes Markdown safe to compile as MDX: outside code, `{` and `}` are
 * escaped and `<` becomes `&lt;`, an autolink becomes a link and an HTML comment is dropped. The
 * Markdown twin of a page keeps the unescaped text.
 */
export function escapeMdx(markdown: string): string {
  return mapProse(markdown, (prose) =>
    prose
      .replace(/<!--.*?-->/g, '')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '[$1]($1)')
      // `<` as a character reference: a backslash would not stop a GFM autolink from eating it.
      .replace(/</g, '&lt;')
      .replace(/[{}]/g, (char) => `\\${char}`),
  );
}

export interface Section {
  readonly heading: string;
  /** The section's text, its heading line included. */
  readonly text: string;
}

/** The sections of a document cut at its headings of `level` (fenced code is not cut). */
export function sectionsOf(markdown: string, level = 2): Section[] {
  const marker = `${'#'.repeat(level)} `;
  const sections: { heading: string; lines: string[] }[] = [];
  for (const { text, code } of linesOf(markdown)) {
    if (!code && text.startsWith(marker)) {
      sections.push({ heading: text.slice(marker.length).trim(), lines: [text] });
    } else {
      sections.at(-1)?.lines.push(text);
    }
  }
  return sections.map(({ heading, lines }) => ({ heading, text: lines.join('\n').trimEnd() }));
}

/** Cells of one Markdown table row; `\|` stays inside its cell. */
export function cellsOf(row: string): string[] {
  const body = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [''];
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? '';
    if (char === '\\' && body[i + 1] === '|') {
      cells[cells.length - 1] += '\\|';
      i++;
    } else if (char === '|') {
      cells.push('');
    } else {
      cells[cells.length - 1] += char;
    }
  }
  return cells.map((cell) => cell.trim());
}

/** The first table under the heading line `heading`: its header cells and its rows. */
export function tableUnder(
  markdown: string,
  heading: string,
): { readonly header: string[]; readonly rows: string[][] } {
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no "${heading}" heading`);
  const first = lines.findIndex((line, i) => i > start && line.startsWith('|'));
  if (first < 0) throw new Error(`no table under "${heading}"`);
  const table: string[] = [];
  for (let i = first; i < lines.length && (lines[i] ?? '').startsWith('|'); i++) {
    table.push(lines[i] ?? '');
  }
  const [header = '', , ...body] = table;
  return { header: cellsOf(header), rows: body.map(cellsOf) };
}

/** A Markdown table; a `|` inside a cell is escaped. */
export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const cell = (value: string): string => value.replace(/(?<!\\)\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

/** Inline code for a value that may itself contain backticks. */
export function code(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * Plain text (a plugin's description, a permission's reason) placed in
 * Markdown: the characters Markdown would read as markup are escaped, so
 * `release-*` stays `release-*` instead of starting an emphasis.
 */
export function text(value: string): string {
  return value.replace(/[\\`*_[\]<>#|~]/g, (char) => `\\${char}`);
}

/** The first sentence of a paragraph: what a page quotes as its summary. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(flat);
  return match?.[1] ?? flat;
}
