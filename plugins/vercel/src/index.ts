/**
 * `@vaubaan/plugin-vercel` — the Vercel provider plugin.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/vercel.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time ; the YAML catalog is loaded here, once, when the
 * module is first imported (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import {
  classifyVercel,
  toVercelEnv,
  vercelEnvOf,
  VERCEL_ENVS,
  type VercelEnv,
} from './classify.ts';
import {
  vercelAuth,
  vercelCredential,
  VERCEL_TEAM_ID_PATTERN,
  VERCEL_TOKENS_URL,
} from './credential.ts';
import { vercelDataModel } from './data-model.ts';
import {
  DISCOVERY_MAX_PAGES,
  DISCOVERY_PAGE_SIZE,
  discoverVercelResources,
  executeVercel,
  VERCEL_API_BASE,
  VERCEL_MCP_URL,
} from './execute.ts';
import { vercelToolTitles } from './tool-titles.ts';
import { vercelTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const VERCEL_CATALOG_PATH = catalogPathNextTo(import.meta.url);

export const vercelCatalog = loadCatalogFile(VERCEL_CATALOG_PATH);

export const vercelPlugin = definePlugin({
  id: 'vercel',
  displayName: 'Vercel',
  version: '3.0.0',
  description:
    'Runtime hosting plane — projects, deployments, logs, env vars, custom domains, firewall, preview comments.',
  summary:
    "One account is one Vercel access token pinned to a team; one resource is one project of that team. The environment is not a label you set: Vercel's own production, preview and development environments are read from each call, so the same project can run freely on preview and ask first on production.",
  manualRevocation: 'Delete the access token in your Vercel account settings, under Tokens.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/vercel.md',
  tools: vercelTools,
  toolTitles: vercelToolTitles,
  dataModel: vercelDataModel,
  catalog: vercelCatalog.catalog,
  credential: vercelCredential,
  classify: classifyVercel,
  execute: executeVercel,
  discoverResources: discoverVercelResources,
  // The environment is the `env[<label>]` segment of the slice, not the
  // owner's label on the project resource (ADR fallback-risk-only-when-uncategorized D4).
  envOf: (slice) => vercelEnvOf(slice) ?? undefined,
});

export default vercelPlugin;

export {
  classifyVercel,
  discoverVercelResources,
  executeVercel,
  toVercelEnv,
  vercelAuth,
  vercelCredential,
  vercelDataModel,
  vercelEnvOf,
  vercelTools,
  DISCOVERY_MAX_PAGES,
  DISCOVERY_PAGE_SIZE,
  VERCEL_API_BASE,
  VERCEL_ENVS,
  VERCEL_MCP_URL,
  VERCEL_TEAM_ID_PATTERN,
  VERCEL_TOKENS_URL,
  type VercelEnv,
};
