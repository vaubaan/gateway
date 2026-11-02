/**
 * The site's fixed addresses, written once. Importable from pages (no IO).
 */

/** The canonical origin of every page (website spec §2.6: canonical URLs). */
export const SITE_ORIGIN = 'https://vaubaan.com';

/** The public repository: every "backed by" link of the site points into it. */
export const GITHUB_REPO = 'https://github.com/vaubaan/gateway';

/** A file of the repository, on its default branch. */
export function githubBlob(path: string): string {
  return `${GITHUB_REPO}/blob/main/${path.replace(/^\/+/, '')}`;
}

/** A directory of the repository, on its default branch. */
export function githubTree(path: string): string {
  return `${GITHUB_REPO}/tree/main/${path.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

/** The collector's public aggregates (website spec §2.4), read when a plugin page is served. */
export const PLUGIN_STATS_URL =
  'https://telemetry.vaubaan.com/v1/plugin_stats?select=plugin,plugin_version,reports,successes,credential_rejections,success_rate,validated&tool=is.null';
export const PLUGIN_INSTANCES_URL = 'https://telemetry.vaubaan.com/v1/plugin_instances';

export const SITE_NAME = 'Vaubaan Gateway';

export const SITE_DESCRIPTION =
  'An open source MCP gateway you install on your own network: coding agents use your cloud services through missions, never through your credentials.';

/** The licence of the code base (`LICENSE`). */
export const LICENSE_NAME = 'Apache-2.0';
