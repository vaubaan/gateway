/**
 * Build-time generator of the site (ADR website-nextjs-on-vercel).
 * Run before `next build`, `next dev` and the type-check:
 *
 *   npm run generate --workspace @vaubaan/website
 *
 * It reads the repository — the plugins, the configuration handbook, the
 * known limitations, the threat model, the collector's thresholds — and the
 * collector's public aggregates (optional: offline, every plugin reads "not
 * enough reports yet"), builds the site as data (`src/content/build-site.ts`)
 * and writes:
 *
 *   content/docs/configuration/keys.mdx, content/docs/known-limitations.mdx,
 *   content/docs/providers/<id>.mdx      the generated docs pages
 *   public/                              Markdown twins, llms.txt, llms-full.txt,
 *                                        plugins.json, sitemap.xml, robots.txt
 *   .generated/site.json                 what the pages render
 *
 * All three are gitignored. VAUBAAN_SITE_OFFLINE=1 skips the network.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { buildSite, DOCS_DIR_FROM_REPO, generatedMdx } from '../src/content/build-site';
import { fetchHealth, type HealthSnapshot } from '../src/content/health';
import { splitFrontmatter } from '../src/content/markdown';
import { loadPlugins } from '../src/content/plugins';
import { readRepoFile, REPO_ROOT, WEBSITE_ROOT } from '../src/content/repo';
import { parseThresholds, THRESHOLDS_SOURCE } from '../src/content/thresholds';
import { PLUGIN_STATS_URL } from '../src/site/constants';

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

async function readHealth(): Promise<HealthSnapshot> {
  if (process.env.VAUBAAN_SITE_OFFLINE === '1') {
    return { fetchedAt: null, rows: [], problem: 'offline (VAUBAAN_SITE_OFFLINE=1)' };
  }
  return fetchHealth(PLUGIN_STATS_URL);
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
    snapshot: await readHealth(),
    lastModified,
  });

  removeGeneratedDocs(DOCS_DIR);
  for (const doc of site.generatedDocs) write(join(DOCS_DIR, doc.file), generatedMdx(doc));

  rmSync(PUBLIC_DIR, { recursive: true, force: true });
  for (const [path, content] of site.files) write(join(PUBLIC_DIR, path), content);
  write(join(GENERATED_DIR, 'site.json'), `${JSON.stringify(site.data, null, 2)}\n`);

  const docs = site.pages.filter((p) => p.group === 'docs').length;
  const health = site.data.healthFetchedAt ? 'read' : 'not read (offline or unreachable)';
  process.stdout.write(
    `website: ${site.plugins.length} plugins, ${docs} docs pages, ${site.pages.length} pages, ${site.files.size} public files; plugin health ${health}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
