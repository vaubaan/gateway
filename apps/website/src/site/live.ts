/**
 * The part of the site rendered at request time: plugin health (website
 * spec §2.4). The pages under `/plugins`, their Markdown twins,
 * `llms-full.txt` and `plugins.json` read the collector's public aggregates
 * here and are cached by Next.js for `HEALTH_REVALIDATE_SECONDS` (every
 * route that calls this exports the same number as `revalidate`:
 * `health-revalidate.test.ts` keeps them equal). Everything else on those
 * pages comes from the generated `site.json`.
 *
 * The two aggregates (`plugin_stats`, `plugin_instances`) are read in
 * parallel and each on its own: one that does not answer gives "not read" on
 * its figures only, never an error page; the next revalidation tries again.
 */
import { fetchHealth, unreadSnapshot, type HealthSnapshot } from '../content/health';
import { llmsFullTxt, pluginsJson, type SitePage } from '../content/outputs';
import {
  PLUGIN_GROUP_PATH,
  pluginGroupMarkdown,
  withHealth,
  type PluginWithHealth,
} from '../content/plugin-pages';
import type { ValidationThresholds } from '../content/thresholds';
import { PLUGIN_INSTANCES_URL, PLUGIN_STATS_URL } from './constants';
import { siteData, type SiteData } from './data';

/** How long a rendered page or file is served before the collector is read again. */
export const HEALTH_REVALIDATE_SECONDS = 3600;

export interface LiveSite {
  readonly plugins: readonly PluginWithHealth[];
  readonly thresholds: ValidationThresholds;
  readonly snapshot: HealthSnapshot;
  /** The Markdown of every page under `/plugins`, by path, with the health read. */
  readonly markdown: Readonly<Record<string, string>>;
}

async function readHealth(): Promise<HealthSnapshot> {
  if (process.env.VAUBAAN_SITE_OFFLINE === '1') {
    return unreadSnapshot('offline (VAUBAAN_SITE_OFFLINE=1)');
  }
  // One read an hour for the whole site: every route shares the entries of the data cache.
  return fetchHealth({ stats: PLUGIN_STATS_URL, instances: PLUGIN_INSTANCES_URL }, (url, init) =>
    fetch(url, { ...init, next: { revalidate: HEALTH_REVALIDATE_SECONDS } }),
  );
}

/** The generated site joined with a snapshot of the collector; pure, for the tests. */
export function liveSiteFrom(data: SiteData, snapshot: HealthSnapshot): LiveSite {
  const plugins = withHealth(data.plugins, snapshot);
  return {
    plugins,
    thresholds: data.thresholds,
    snapshot,
    markdown: pluginGroupMarkdown(plugins, data.thresholds, snapshot),
  };
}

/** The site with the collector read now (or found unreachable). */
export async function liveSite(): Promise<LiveSite> {
  return liveSiteFrom(siteData(), await readHealth());
}

/** The Markdown of any page: live under `/plugins`, generated elsewhere; null for no page. */
export function pageMarkdown(
  path: string,
  live: LiveSite,
  data: SiteData = siteData(),
): string | null {
  if (PLUGIN_GROUP_PATH.test(path)) return live.markdown[path] ?? null;
  return data.markdown[path] ?? null;
}

/** Every listed page with its Markdown, the plugin pages live: what `llms-full.txt` carries. */
export function livePages(live: LiveSite, data: SiteData = siteData()): SitePage[] {
  return data.pages.flatMap((meta) => {
    const markdown = pageMarkdown(meta.path, live, data);
    return markdown === null ? [] : [{ ...meta, markdown }];
  });
}

export function liveLlmsFull(live: LiveSite, data: SiteData = siteData()): string {
  return llmsFullTxt(livePages(live, data).filter((p) => p.group !== 'home'));
}

export function livePluginsJson(live: LiveSite): string {
  return pluginsJson(live.plugins, live.thresholds, live.snapshot, HEALTH_REVALIDATE_SECONDS);
}
