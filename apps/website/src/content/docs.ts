/**
 * The user docs as the generator sees them: the hand-written MDX pages under
 * `content/docs` (plain Markdown, so a page's Markdown twin is its own
 * source), and the generated pages written beside them, marked
 * `generated: true` in their frontmatter and skipped here — the generator
 * holds their canonical Markdown in memory.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { splitFrontmatter } from './markdown';

export interface DocPage {
  /** Site path: `/docs`, `/docs/install/railway`. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** The page as Markdown, title first: the body of its `.md` twin. */
  readonly markdown: string;
  /** Repository paths whose last change dates the page (sitemap). */
  readonly sources: readonly string[];
}

/** `content/docs/install/index.mdx` → `/docs/install`. */
export function docPathOf(fileFromDocsDir: string): string {
  const slug = fileFromDocsDir
    .split(sep)
    .join('/')
    .replace(/\.mdx?$/, '')
    .replace(/(^|\/)index$/, '');
  return slug === '' ? '/docs' : `/docs/${slug}`;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.mdx?$/.test(name) ? [path] : [];
  });
}

/** Constructs that would make an MDX page differ from its Markdown twin. */
const NOT_PLAIN_MARKDOWN = /^(import|export)\s|<[A-Za-z]|\{/;

/**
 * The hand-written pages. Each must be plain Markdown: no import, no
 * component, no expression outside code (checked here and by a test), so the
 * twin served as `.md` says exactly what the HTML says.
 */
export function loadHandwrittenDocs(docsDir: string, docsDirFromRepo: string): DocPage[] {
  return walk(docsDir)
    .map((file) => {
      const text = readFileSync(file, 'utf8');
      const { data, body } = splitFrontmatter(text);
      return { file, data, body };
    })
    .filter(({ data }) => data.generated !== 'true')
    .map(({ file, data, body }) => {
      const rel = relative(docsDir, file);
      const title = data.title;
      const description = data.description;
      if (!title || !description) throw new Error(`${rel}: title and description are required`);
      const offending = proseLines(body).find((line) => NOT_PLAIN_MARKDOWN.test(line));
      if (offending !== undefined) {
        throw new Error(`${rel}: not plain Markdown (${offending.trim().slice(0, 60)})`);
      }
      return {
        path: docPathOf(rel),
        title,
        description,
        markdown: `# ${title}\n\n${body.trim()}\n`,
        sources: [`${docsDirFromRepo}/${rel.split(sep).join('/')}`],
      };
    });
}

/** The lines of a Markdown text outside fenced code, with inline code removed. */
export function proseLines(markdown: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match?.[1]) {
      if (fence === null) fence = match[1];
      else if (match[1][0] === fence[0]) fence = null;
      continue;
    }
    if (fence === null) out.push(line.replace(/`+[^`]*`+/g, ''));
  }
  return out;
}

/**
 * The sidebar order of `meta.json` files (`pages`, with `...` for the rest),
 * flattened. `virtualFiles` are pages not written yet (the generated ones),
 * by path from `docsDir`, counted as if they were on disk.
 */
export function orderDocs(
  pages: readonly DocPage[],
  docsDir: string,
  virtualFiles: readonly string[] = [],
): DocPage[] {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const ordered: DocPage[] = [];
  const visit = (dir: string, prefix: string): void => {
    const metaPath = join(dir, 'meta.json');
    const meta = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { pages?: string[] })
      : {};
    const names = meta.pages ?? ['...'];
    const virtual = virtualFiles
      .map((file) => file.split('/'))
      .filter((parts) => parts.slice(0, -1).join(sep) === prefix)
      .map((parts) => parts.at(-1) ?? '');
    const children = [
      ...new Set(
        [...readdirSync(dir), ...virtual]
          .filter((name) => name !== 'meta.json')
          .map((name) => name.replace(/\.mdx?$/, '')),
      ),
    ].sort();
    const listed = new Set(names.filter((n) => n !== '...'));
    for (const name of names) {
      const batch = name === '...' ? children.filter((c) => !listed.has(c)) : [name];
      for (const entry of batch) {
        const childDir = join(dir, entry);
        const path = docPathOf(join(prefix, entry));
        if (existsSync(childDir) && statSync(childDir).isDirectory()) {
          const index = byPath.get(path);
          if (index && !ordered.includes(index)) ordered.push(index);
          visit(childDir, join(prefix, entry));
        } else {
          const page = byPath.get(path);
          if (page && !ordered.includes(page)) ordered.push(page);
        }
      }
    }
  };
  visit(docsDir, '');
  // Anything the meta files do not reach still appears, last.
  for (const page of pages) if (!ordered.includes(page)) ordered.push(page);
  return ordered;
}

/**
 * Ends the Markdown of a folder's index page with the list of its pages, as
 * the HTML page does ("In this section"); the docs home has its own links.
 */
export function withSectionLists(ordered: readonly DocPage[]): DocPage[] {
  return ordered.map((page) => {
    if (page.path === '/docs') return page;
    const children = ordered.filter((other) => {
      if (!other.path.startsWith(`${page.path}/`)) return false;
      return !other.path.slice(page.path.length + 1).includes('/');
    });
    if (children.length === 0) return page;
    const list = children.map((child) => `- [${child.title}](${child.path})`).join('\n');
    return { ...page, markdown: `${page.markdown.trimEnd()}\n\n## In this section\n\n${list}\n` };
  });
}
