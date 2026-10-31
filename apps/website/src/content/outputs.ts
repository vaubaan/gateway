/**
 * What the site serves for language models, agents and crawlers (website
 * spec §2.6), built from the same page list the HTML is built from:
 * `llms.txt`, `llms-full.txt`, `plugins.json`, `sitemap.xml`, `robots.txt`
 * and the Markdown twin path of every page. Pure functions.
 */
import { GITHUB_REPO, SITE_DESCRIPTION, SITE_NAME, SITE_ORIGIN } from '../site/constants';
import type { PluginWithHealth } from './plugin-pages';
import type { ValidationThresholds } from './thresholds';

export type PageGroup = 'home' | 'docs' | 'plugins' | 'trust';

export interface SitePage {
  readonly path: string;
  readonly group: PageGroup;
  readonly title: string;
  readonly description: string;
  readonly markdown: string;
  /** ISO date of the last change of the page's sources, when known. */
  readonly lastModified: string | null;
}

/** `/docs/install` → `/docs/install.md`; `/` → `/index.md`. */
export function twinPathOf(path: string): string {
  return path === '/' ? '/index.md' : `${path}.md`;
}

export function absolute(path: string): string {
  return `${SITE_ORIGIN}${path === '/' ? '' : path}`;
}

const GROUP_TITLES: Readonly<Record<Exclude<PageGroup, 'home'>, string>> = {
  docs: 'Docs',
  plugins: 'Plugins',
  trust: 'Trust center',
};

/** The llms.txt index: a paragraph, then every page with its summary and its Markdown link. */
export function llmsTxt(pages: readonly SitePage[]): string {
  const lines = [
    `# ${SITE_NAME}`,
    '',
    `> ${SITE_DESCRIPTION} A person creates a mission (the accounts and resources an agent may touch, its permissions, limits per period and per minute, and which actions ask them first); the agent gets a key for that mission; the gateway checks every MCP tool call against it, runs it with a credential that stays on the instance, and records it. Pre-release, Apache-2.0, installed with Docker.`,
    '',
    `Every page below is Markdown at the address given; the HTML page is the same address without \`.md\`. The whole of it in one file: ${absolute('/llms-full.txt')}. Every plugin as JSON: ${absolute('/plugins.json')}. Source: ${GITHUB_REPO}.`,
    '',
  ];
  for (const group of ['docs', 'plugins', 'trust'] as const) {
    lines.push(`## ${GROUP_TITLES[group]}`, '');
    for (const page of pages.filter((p) => p.group === group)) {
      lines.push(`- [${page.title}](${absolute(twinPathOf(page.path))}): ${page.description}`);
    }
    lines.push('');
  }
  lines.push(
    '## Optional',
    '',
    `- [Home page](${absolute('/index.md')}): the pitch and the questions people ask`,
    `- [Repository](${GITHUB_REPO}): code, specification, handbooks and decisions`,
    '',
  );
  return lines.join('\n');
}

/** Every page in one Markdown file, separated by its address. */
export function llmsFullTxt(pages: readonly SitePage[]): string {
  const parts = [`# ${SITE_NAME} — the whole site\n\n> ${SITE_DESCRIPTION}\n`];
  for (const page of pages) {
    parts.push(`---\n\nSource: ${absolute(page.path)}\n\n${page.markdown.trim()}\n`);
  }
  return parts.join('\n');
}

/** `/plugins.json`: the data the plugin pages show. */
export function pluginsJson(
  plugins: readonly PluginWithHealth[],
  thresholds: ValidationThresholds,
  healthFetchedAt: string | null,
): string {
  return `${JSON.stringify(
    {
      generated_from: `${GITHUB_REPO}/tree/main/plugins`,
      validation_thresholds: {
        min_reports: thresholds.minReports,
        min_success_rate: thresholds.minSuccessRate,
        window_days: thresholds.windowDays,
      },
      health_read_at: healthFetchedAt,
      plugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        page: absolute(`/plugins/${p.id}`),
        source: `${GITHUB_REPO}/tree/main/${p.dir}`,
        health:
          p.health.state === 'measured'
            ? {
                state: 'measured',
                reports: p.health.reports,
                success_rate: p.health.successRate,
                validated: p.health.validated,
              }
            : { state: 'not-enough-reports' },
        tools: p.tools.map((t) => ({ name: t.name, title: t.title, description: t.description })),
        risks: p.risks.map((r) => ({
          id: r.id,
          label: r.label,
          reason: r.reason,
          severity: r.severity,
          kind: r.kind,
          acceptable_in_envs: r.acceptableInEnvs,
          fallback: r.fallback,
        })),
        macro_actions: p.macroActions.map((action) => ({
          id: action.id,
          label: action.label,
          description: action.description,
          entries: action.entries.map((e) => ({
            risk_id: e.riskId,
            quota: e.quota,
            rate_limit: { max: e.rateMax, window_seconds: e.rateWindowSeconds },
          })),
        })),
      })),
    },
    null,
    2,
  )}\n`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sitemapXml(pages: readonly SitePage[]): string {
  const urls = pages.map((page) => {
    const lastmod = page.lastModified ? `<lastmod>${page.lastModified}</lastmod>` : '';
    return `  <url><loc>${escapeXml(absolute(page.path))}</loc>${lastmod}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** The AI crawlers named in robots.txt (website spec §2.6), each allowed everything. */
export const NAMED_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'PerplexityBot',
  'Google-Extended',
  'CCBot',
] as const;

/** robots.txt of vaubaan.com: every crawler welcome, nothing disallowed. */
export function robotsTxt(): string {
  const groups = [...NAMED_CRAWLERS, '*'].map((agent) => `User-agent: ${agent}\nAllow: /\n`);
  return `${groups.join('\n')}\nSitemap: ${absolute('/sitemap.xml')}\n`;
}

/**
 * robots.txt of the collector's host: it serves no page, so crawlers are
 * asked to stay away (website spec §2.6: "except the collector's host").
 */
export const COLLECTOR_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';
