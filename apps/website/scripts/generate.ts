/**
 * Build-time generator of the site (ADR website-nextjs-on-vercel).
 * Run before `next build`, `next dev` and the type-check:
 *
 *   npm run generate --workspace @vaubaan/website
 *
 * It reads the repository — the plugins, the configuration handbook, the
 * known limitations, the threat model, the collector's thresholds — builds
 * the site as data (`src/content/build-site.ts`) and writes:
 *
 *   content/docs/configuration/keys.mdx, content/docs/known-limitations.mdx
 *                                        the generated docs pages
 *   public/                              llms.txt, sitemap.xml, robots.txt, and the
 *                                        connect guides' screenshots
 *                                        (plugins/<id>/connect/<file>)
 *   .generated/site.json                 what the pages render
 *
 * All three are gitignored. It reads no network: plugin health is read when
 * a page is rendered (`src/site/live.ts`), and the Markdown twins,
 * llms-full.txt and plugins.json are rendered by routes for the same reason.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { buildSite, DOCS_DIR_FROM_REPO, generatedMdx } from '../src/content/build-site';
import { splitFrontmatter } from '../src/content/markdown';
import { loadPlugins } from '../src/content/plugins';
import { readRepoFile, REPO_ROOT, WEBSITE_ROOT } from '../src/content/repo';
import { parseThresholds, THRESHOLDS_SOURCE } from '../src/content/thresholds';

const DOCS_DIR = join(REPO_ROOT, DOCS_DIR_FROM_REPO);
const PUBLIC_DIR = join(WEBSITE_ROOT, 'public');
const GENERATED_DIR = join(WEBSITE_ROOT, '.generated');

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The date of the last commit touching any of `paths`, or null (no git, or a shallow clone). */
function lastModified(paths: readonly string[]): string | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', ...paths], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Removes the generated docs pages of an earlier run (a plugin may have been renamed or removed). */
function removeGeneratedDocs(dir: string): void {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) removeGeneratedDocs(path);
    else if (/\.mdx?$/.test(name.name)) {
      if (splitFrontmatter(readFileSync(path, 'utf8')).data.generated === 'true') rmSync(path);
    }
  }
}

async function main(): Promise<void> {
  const site = buildSite({
    repoRoot: REPO_ROOT,
    plugins: await loadPlugins(REPO_ROOT),
    thresholds: parseThresholds(readRepoFile(THRESHOLDS_SOURCE)),
    lastModified,
  });

  removeGeneratedDocs(DOCS_DIR);
  for (const doc of site.generatedDocs) write(join(DOCS_DIR, doc.file), generatedMdx(doc));

  rmSync(PUBLIC_DIR, { recursive: true, force: true });
  for (const [path, content] of site.files) write(join(PUBLIC_DIR, path), content);
  for (const [path, source] of site.assets) {
    mkdirSync(dirname(join(PUBLIC_DIR, path)), { recursive: true });
    copyFileSync(join(REPO_ROOT, source), join(PUBLIC_DIR, path));
  }
  write(join(GENERATED_DIR, 'site.json'), `${JSON.stringify(site.data, null, 2)}\n`);

  const docs = site.pages.filter((p) => p.group === 'docs').length;
  process.stdout.write(
    `website: ${site.plugins.length} plugins, ${docs} docs pages, ${site.pages.length} pages, ${site.files.size + site.assets.size} public files; plugin health is read when a page is rendered\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
