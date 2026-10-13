/**
 * `@vaubaan/plugin-supabase` — the Supabase provider plugin.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/supabase.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time and the YAML catalog is loaded here, once, when
 * the module is first imported (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifySupabase, SUPABASE_CLASSIFIED_TOOLS, SUPABASE_TOOL_PLANES } from './classify.ts';
import { supabaseCredential } from './credential.ts';
import { supabaseDataModel } from './data-model.ts';
import { discoverSupabaseResources, executeSupabase } from './execute.ts';
import { supabaseTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const supabaseCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const supabasePlugin = definePlugin({
  id: 'supabase',
  displayName: 'Supabase',
  version: '4.0.0',
  description:
    'Postgres, storage, auth and edge functions of Supabase projects, through the Management API.',
  summary:
    "One connection is your company's Supabase OAuth app authorised on an organisation; one resource is one project (database, storage, auth and edge functions). Supabase runs one project per environment, so the connection owner labels each project (staging, prod, …) and the environment-scoped risks apply to the projects carrying that label.",
  manualRevocation:
    "Revoke your company's OAuth app in the settings of the Supabase organisation, under the authorised OAuth apps.",
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/supabase.md',
  tools: supabaseTools,
  dataModel: supabaseDataModel,
  catalog: supabaseCatalog.catalog,
  credential: supabaseCredential,
  classify: classifySupabase,
  execute: executeSupabase,
  discoverResources: discoverSupabaseResources,
});

export default supabasePlugin;

export {
  classifySupabase,
  supabaseCredential,
  supabaseDataModel,
  supabaseTools,
  SUPABASE_CLASSIFIED_TOOLS,
  SUPABASE_TOOL_PLANES,
};
export type { SupabasePlane } from './classify.ts';
export {
  SUPABASE_APP_CONFIG_KEYS,
  SUPABASE_OAUTH_AUTHORIZE_URL,
  SUPABASE_OAUTH_TOKEN_URL,
} from './credential.ts';
export { MAX_DISCOVERED_PROJECTS, SUPABASE_API_BASE, projectUrl } from './execute.ts';
