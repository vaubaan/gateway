/**
 * The whole site as data, built from the repository: every page with its
 * Markdown, the generated docs pages, and the files served from `public/`
 * (Markdown twins, llms.txt, llms-full.txt, plugins.json, sitemap.xml,
 * robots.txt). The generator (`scripts/generate.ts`) writes what this
 * returns; the tests read it without writing anything.
 */
import { join } from 'node:path';

import type { SiteData } from '../site/data';
import { LANDING_LEDE, landingMarkdown } from '../site/landing';
import { configKeysMarkdown, CONFIG_HANDBOOK, parseConfigKeys } from './config-keys';
import { loadHandwrittenDocs, orderDocs, withSectionLists, type DocPage } from './docs';
import type { HealthSnapshot } from './health';
import {
  escapeMdx,
  rewriteRelativeLinks,
  sectionsOf,
  splitFrontmatter,
  splitTitle,
} from './markdown';
import {
  llmsFullTxt,
  llmsTxt,
  pluginsJson,
  robotsTxt,
  sitemapXml,
  twinPathOf,
  type SitePage,
} from './outputs';
import {
  connectPageMarkdown,
  healthPageMarkdown,
  pluginListMarkdown,
  pluginPageDescription,
  pluginPageMarkdown,
  pluginPageTitle,
  withHealth,
  type PluginWithHealth,
} from './plugin-pages';
import type { PluginInfo } from './plugins';
import { readRepoFile } from './repo';
import { THRESHOLDS_SOURCE, type ValidationThresholds } from './thresholds';
import { parseAcceptedRisks, parseOutOfScope, THREAT_MODEL, trustMarkdown } from './trust';

export const DOCS_DIR_FROM_REPO = 'apps/website/content/docs';
export const KNOWN_LIMITATIONS = 'docs/handbook/known-limitations.md';

export interface GeneratedDoc {
  readonly page: DocPage;
  /** Where its MDX file goes, from `content/docs`. */
  readonly file: string;
}

export interface SiteInputs {
  readonly repoRoot: string;
  readonly plugins: readonly PluginInfo[];
  readonly thresholds: ValidationThresholds;
  readonly snapshot: HealthSnapshot;
  /** The date of the last change of repository paths, or null when unknown. */
  readonly lastModified: (paths: readonly string[]) => string | null;
}

export interface BuiltSite {
  readonly pages: readonly SitePage[];
  readonly generatedDocs: readonly GeneratedDoc[];
  readonly plugins: readonly PluginWithHealth[];
  /** The files of `public/`, by path from it (`docs/install.md`, `llms.txt`). */
  readonly files: ReadonlyMap<string, string>;
  /** What the pages render (`.generated/site.json`). */
  readonly data: SiteData;
}

function generatedDoc(
  file: string,
  path: string,
  title: string,
  description: string,
  body: string,
  sources: readonly string[],
): GeneratedDoc {
  return {
    file,
    page: { path, title, description, markdown: `# ${title}\n\n${body.trim()}\n`, sources },
  };
}

function configurationKeysDoc(): GeneratedDoc {
  const rows = parseConfigKeys(readRepoFile(CONFIG_HANDBOOK));
  const body = [
    "This page lists every configuration key of an instance, with its environment variable, its type, its default and what it accepts; it is generated from the key table of the repository's configuration handbook, which a test holds to the gateway's own loader.",
    '',
    'A key is set in the YAML file named by `VAUBAAN_CONFIG_FILE` or by its environment variable; when both set a key, the file wins, silently. Secrets may also be given as `${NAME}` or `${file:/path}` references in the file, or through the `*_FILE` variables. Anything required and missing stops the instance at start with exit code 78 and a message naming every key. How the sources combine: [configuration](/docs/configuration).',
    '',
    configKeysMarkdown(rows),
    '',
    `Source: the "Configuration keys" table of [${CONFIG_HANDBOOK}](https://github.com/vaubaan/gateway/blob/main/${CONFIG_HANDBOOK}#configuration-keys), which also says which part of the code reads each key.`,
  ].join('\n');
  return generatedDoc(
    'configuration/keys.mdx',
    '/docs/configuration/keys',
    'Configuration keys',
    `Every configuration key of an instance (${rows.length} rows), its environment variable, type, default and accepted values.`,
    body,
    [CONFIG_HANDBOOK, 'apps/gateway/src/server/config/sources.ts'],
  );
}

function knownLimitationsDoc(): GeneratedDoc {
  const { body } = splitFrontmatter(readRepoFile(KNOWN_LIMITATIONS));
  const { rest } = splitTitle(body);
  const list = rewriteRelativeLinks(rest.trim(), KNOWN_LIMITATIONS);
  const lede = `This page is the repository's list of known limitations of Vaubaan Gateway, copied at build time from [${KNOWN_LIMITATIONS}](https://github.com/vaubaan/gateway/blob/main/${KNOWN_LIMITATIONS}): what was never tried, what is not enforced, what is not built.`;
  return generatedDoc(
    'known-limitations.mdx',
    '/docs/known-limitations',
    'Known limitations',
    'What has not been done and what is not there in this version: never run for real, not enforced, one process, not built.',
    `${lede}\n\n${list}`,
    [KNOWN_LIMITATIONS],
  );
}

/** The hand-written "Credential…" sections of a plugin's README, links pointed at GitHub. */
export function readmeCredentialSections(plugin: Pick<PluginInfo, 'dir'>): string {
  const readmePath = `${plugin.dir}/README.md`;
  const { body } = splitFrontmatter(readRepoFile(readmePath));
  const sections = sectionsOf(body, 2).filter((s) => /^credential/i.test(s.heading));
  return rewriteRelativeLinks(sections.map((s) => s.text).join('\n\n'), readmePath);
}

function providerDoc(plugin: PluginInfo): GeneratedDoc {
  const markdown = connectPageMarkdown(plugin, readmeCredentialSections(plugin));
  return generatedDoc(
    `providers/${plugin.id}.mdx`,
    `/docs/providers/${plugin.id}`,
    `Connect ${plugin.name}`,
    `How to connect a ${plugin.name} account to Vaubaan Gateway${plugin.experimental ? ' (experimental plugin)' : ''}: the company app or the token, and what to grant.`,
    splitTitle(markdown).rest,
    [plugin.dir],
  );
}

/** The MDX file of a generated docs page: frontmatter, a do-not-edit note, escaped Markdown. */
export function generatedMdx(doc: GeneratedDoc): string {
  const { page } = doc;
  return [
    '---',
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    'generated: true',
    '---',
    '',
    `{/* Generated by apps/website/scripts/generate.ts from ${page.sources.join(', ')}. Do not edit. */}`,
    '',
    escapeMdx(splitTitle(page.markdown).rest.trim()),
    '',
  ].join('\n');
}

export function buildSite(inputs: SiteInputs): BuiltSite {
  const { repoRoot, plugins, thresholds, snapshot, lastModified } = inputs;
  const docsDir = join(repoRoot, DOCS_DIR_FROM_REPO);
  const withStatus = withHealth(plugins, snapshot, thresholds);

  const generatedDocs = [
    configurationKeysDoc(),
    knownLimitationsDoc(),
    ...plugins.map(providerDoc),
  ];
  const docs = withSectionLists(
    orderDocs(
      [...loadHandwrittenDocs(docsDir, DOCS_DIR_FROM_REPO), ...generatedDocs.map((g) => g.page)],
      docsDir,
      generatedDocs.map((g) => g.file),
    ),
  );

  const threatModel = readRepoFile(THREAT_MODEL);
  const serviceNames = plugins.map((p) => (p.experimental ? `${p.name} (experimental)` : p.name));
  const markdown: Record<string, string> = {
    '/': landingMarkdown(serviceNames),
    '/plugins': pluginListMarkdown(withStatus),
    '/plugins/health': healthPageMarkdown(withStatus, thresholds, snapshot),
    '/trust': trustMarkdown({
      acceptedRisks: parseAcceptedRisks(threatModel),
      outOfScope: parseOutOfScope(threatModel),
      thresholds,
    }),
  };
  for (const plugin of withStatus) {
    markdown[`/plugins/${plugin.id}`] = pluginPageMarkdown(plugin, thresholds);
  }
  const md = (path: string): string => markdown[path] ?? '';

  const pages: SitePage[] = [
    {
      path: '/',
      group: 'home',
      title: 'Vaubaan Gateway',
      description: LANDING_LEDE,
      markdown: md('/'),
      lastModified: lastModified(['apps/website/src/site/landing.ts', 'plugins']),
    },
    ...docs.map((doc) => ({
      path: doc.path,
      group: 'docs' as const,
      title: doc.title,
      description: doc.description,
      markdown: doc.markdown,
      lastModified: lastModified(doc.sources),
    })),
    {
      path: '/plugins',
      group: 'plugins',
      title: 'Plugins',
      description: `The ${plugins.length} plugins shipped with Vaubaan Gateway, with their version, status and health.`,
      markdown: md('/plugins'),
      lastModified: lastModified(['plugins']),
    },
    {
      path: '/plugins/health',
      group: 'plugins',
      title: 'Plugin health',
      description:
        'Per plugin version, the calls reported by the instances that opted in to telemetry, and whether it is validated.',
      markdown: md('/plugins/health'),
      lastModified: lastModified([THRESHOLDS_SOURCE]),
    },
    ...withStatus.map((plugin) => ({
      path: `/plugins/${plugin.id}`,
      group: 'plugins' as const,
      title: pluginPageTitle(plugin),
      description: pluginPageDescription(plugin),
      markdown: md(`/plugins/${plugin.id}`),
      lastModified: lastModified([plugin.dir]),
    })),
    {
      path: '/trust',
      group: 'trust',
      title: 'Trust center',
      description:
        'What protects the credentials an instance holds, what is not covered, what leaves an instance, and how to report a vulnerability.',
      markdown: md('/trust'),
      lastModified: lastModified([
        'apps/website/src/content/trust.ts',
        THREAT_MODEL,
        'SECURITY.md',
        'deploy/collector/README.md',
      ]),
    },
  ];

  const files = new Map<string, string>();
  for (const page of pages) files.set(twinPathOf(page.path).slice(1), page.markdown);
  const listed = pages.filter((p) => p.group !== 'home');
  files.set('llms.txt', llmsTxt(listed));
  files.set('llms-full.txt', llmsFullTxt(listed));
  files.set('plugins.json', pluginsJson(withStatus, thresholds, snapshot.fetchedAt));
  files.set('sitemap.xml', sitemapXml(pages));
  files.set('robots.txt', robotsTxt());

  const data: SiteData = {
    thresholds,
    healthFetchedAt: snapshot.fetchedAt,
    plugins: withStatus,
    markdown: Object.fromEntries(Object.entries(markdown).filter(([path]) => path !== '/')),
    pages: pages.map(({ markdown: _markdown, ...meta }) => meta),
  };

  return { pages, generatedDocs, plugins: withStatus, files, data };
}
