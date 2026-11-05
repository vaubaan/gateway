/**
 * What the site serves for language models, agents and crawlers (website
 * spec §2.6), built from the same page list the HTML is built from:
 * `llms.txt`, `llms-full.txt`, `plugins.json`, `sitemap.xml`, `robots.txt`
 * and the Markdown twin path of every page. Pure functions. `llms.txt`,
 * `sitemap.xml` and `robots.txt` are written to `public/` at build time;
 * `llms-full.txt` and `plugins.json` repeat the plugin pages, so a route
 * renders them with the collector read (`src/site/live.ts`).
 */
import { GITHUB_REPO, SITE_DESCRIPTION, SITE_NAME, SITE_ORIGIN } from '../site/constants';
import {
  healthFootnote,
  NOT_READ,
  type HealthSnapshot,
  type LineFigures,
  type PluginHealth,
} from './health';
import type { PluginWithHealth } from './plugin-pages';
import type { LevelBudgets, MacroActionInfo, RiskInfo } from './plugins';
import type { ValidationThresholds } from './thresholds';

/** The files served by a route rather than from `public/` (rendered with the collector read). */
export const LIVE_FILES = ['plugins.json', 'llms-full.txt'] as const;

/** The files served by a route rendered once at build (`app/versions.json`). */
export const BUILT_ROUTE_FILES = ['versions.json'] as const;

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

/** A figure of `plugins.json`: null when its aggregate was not read (see `health_read`). */
function figure<T>(value: T | typeof NOT_READ): T | null {
  return value === NOT_READ ? null : value;
}

function lineJson(line: LineFigures, key: 'minor' | 'version'): Record<string, unknown> {
  return {
    [key]: line.label,
    gateways: figure(line.gateways),
    calls: figure(line.calls),
    success_rate: figure(line.successRate),
    ...(key === 'version' ? { validated: line.validated } : {}),
  };
}

/** The `health` of one plugin in `plugins.json`: the same figures as its pages. */
function healthJson(health: PluginHealth): Record<string, unknown> {
  return {
    gateways: figure(health.gateways),
    minors: health.minors.map((line) => lineJson(line, 'minor')),
    versions: health.versions.map((line) => lineJson(line, 'version')),
  };
}

/**
 * `/plugins.json`: the data the plugin pages show, with the health read at
 * `health_read_at` (null when the collector could not be read) and refreshed
 * at most every `health_refreshed_every_seconds`. `health_read` says which of
 * the two aggregates were read: a figure of one that was not is null (a
 * `success_rate` is also null when no call counts).
 */
export function pluginsJson(
  plugins: readonly PluginWithHealth[],
  thresholds: ValidationThresholds,
  snapshot: HealthSnapshot,
  healthRefreshedEverySeconds: number,
): string {
  return `${JSON.stringify(
    {
      generated_from: `${GITHUB_REPO}/tree/main/plugins`,
      validation_thresholds: {
        min_reports: thresholds.minReports,
        min_success_rate: thresholds.minSuccessRate,
        window_days: thresholds.windowDays,
      },
      health_read_at: snapshot.fetchedAt,
      health_refreshed_every_seconds: healthRefreshedEverySeconds,
      health_read: {
        calls: snapshot.stats.rows !== null,
        gateways: snapshot.instances.rows !== null,
      },
      health_footnote: healthFootnote(thresholds.windowDays),
      plugins: plugins.map(pluginJson),
    },
    null,
    2,
  )}\n`;
}

function rateJson(max: number, windowSeconds: number): Record<string, number> {
  return { max, window_seconds: windowSeconds };
}

/** The line of each trust level: `gate` null when the level leaves the permission out. */
function levelsJson(levels: LevelBudgets): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(levels).map(([level, line]) => [
      level,
      {
        gate: line.gate,
        gate_word: line.gateWord,
        quota: line.quota,
        rate_limit: rateJson(line.rateMax, line.rateWindowSeconds),
      },
    ]),
  );
}

function riskJson(r: RiskInfo): Record<string, unknown> {
  return {
    id: r.id,
    label: r.label,
    reason: r.reason,
    severity: r.severity,
    kind: r.kind,
    vector: r.vector,
    undo: r.undo,
    tier: r.tier,
    rate_ceiling_per_minute: r.rateCeilingPerMinute,
    patterns: r.patterns,
    facts: r.facts,
    acceptable_in_envs: r.acceptableInEnvs,
    env_variants: r.envVariants,
    fallback: r.fallback,
    deprecated: r.deprecated,
    replaced_by: r.replacedBy,
  };
}

function macroActionJson(action: MacroActionInfo): Record<string, unknown> {
  return {
    id: action.id,
    label: action.label,
    description: action.description,
    narrative: action.narrative,
    entries: action.entries.map((e) => ({
      risk_id: e.riskId,
      quota: e.quota,
      rate_limit: rateJson(e.rateMax, e.rateWindowSeconds),
      trust_levels: levelsJson(e.levels),
      env_trust_levels: e.envLevels.map((row) => ({
        env: row.env,
        trust_levels: levelsJson(row.levels),
      })),
    })),
  };
}

/** One plugin of `plugins.json`: what its page shows, as data. */
function pluginJson(p: PluginWithHealth): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    summary: p.summary,
    icon: p.icon,
    icon_color: p.iconColor,
    resource_noun: p.resourceNoun,
    page: absolute(`/plugins/${p.id}`),
    source: `${GITHUB_REPO}/tree/main/${p.dir}`,
    health: healthJson(p.health),
    counts: {
      permissions: p.counts.permissions,
      macro_actions: p.counts.macroActions,
      tools: p.counts.tools,
      excluded_tools: p.counts.excludedTools,
      examples: p.counts.examples,
    },
    tools: p.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      touches: t.touches,
    })),
    excluded_tools: p.excludedTools,
    risks: p.risks.map(riskJson),
    macro_actions: p.macroActions.map(macroActionJson),
    anything_else: p.anythingElse ? macroActionJson(p.anythingElse) : null,
    retired: p.retired,
    examples: p.examples.map((e) => ({
      tool: e.tool,
      title: e.title,
      sample: e.sample,
      args: e.args,
      slices: e.slices,
      permissions: e.permissions,
      at_careful: {
        outcome: e.atCareful.outcome,
        gates: e.atCareful.gates.map((g) => ({ risk_id: g.riskId, gate: g.gate })),
      },
      in_worked_mission: e.inWorkedMission,
    })),
    worked_mission: {
      trust_level: p.workedMission.trustLevel,
      macro_actions: p.workedMission.macroActions,
      lines: p.workedMission.lines.map((line) => ({
        risk_id: line.riskId,
        gate: line.gate,
        tier: line.tier,
        quota: line.quota,
        rate_limit: rateJson(line.rateMax, line.rateWindowSeconds),
      })),
      left_out: p.workedMission.leftOut.map((l) => ({ risk_id: l.riskId, tier: l.tier })),
      can: p.workedMission.can,
      asks_first: p.workedMission.asksFirst,
      cannot: p.workedMission.cannot,
    },
    credentials: p.credentials.map((c) => ({
      kind: c.kind,
      client_source: c.clientSource,
      broker_provider: c.brokerProvider,
      scopes: c.scopes,
      label: c.label,
      create_url: c.createUrl,
      fields: c.fields,
      steps: c.steps,
      reach: c.reach,
      permissions: c.permissions,
      expiry: c.expiry,
      docs_url: c.docsUrl,
      manual_revocation: c.manualRevocation,
      connect: absolute(`/docs/providers/${p.id}`),
    })),
  };
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
