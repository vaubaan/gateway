/**
 * `@vaubaan/plugin-supabase` — the Supabase plugin.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/services/supabase.md ; guide : plugins/README.md.
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
import { SUPABASE_ICON, SUPABASE_ICON_COLOR } from './icon.ts';
import { SERVICE_ID } from './identity.ts';
import { supabaseToolTitles } from './tool-titles.ts';
import { supabaseTools } from './tools.ts';
import { supabaseExamples } from './examples.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const supabaseCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const supabasePlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'Supabase',
  icon: SUPABASE_ICON,
  iconColor: SUPABASE_ICON_COLOR,
  resourceNoun: { one: 'project', other: 'projects' },
  version: '6.0.0',
  description:
    'Postgres, storage, auth and edge functions of Supabase projects, through the Management API.',
  summary:
    'One account is one personal access token of the Management API, scoped to the whole organization; one resource is one project (database, storage, auth and edge functions). Supabase runs one project per environment, so the owner of the account labels each project (staging, prod, …) and the permissions tied to an environment apply to the projects carrying that label.',
  manualRevocation:
    'Delete the token in Supabase, signed in as the account that created it: Account preferences, Access tokens.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/supabase.md',
  tools: supabaseTools,
  toolTitles: supabaseToolTitles,
  examples: supabaseExamples,
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
export { MAX_DISCOVERED_PROJECTS } from './execute.ts';
export { SERVICE_ID, SUPABASE_API_BASE, TOOL, projectUrl } from './identity.ts';
export {
  AUTH_CONFIG_PUBLIC_FIELDS,
  FUNCTION_SECRET_PUBLIC_FIELDS,
  REDACTED_VALUE,
  redactAuthConfig,
  redactFunctionSecrets,
} from './redact.ts';
export { supabaseBearerOf, verifySupabaseToken, SUPABASE_TOKEN_FIELD } from './credential.ts';
export { EXAMPLE_STAGING_PROJECT, supabaseExamples } from './examples.ts';
