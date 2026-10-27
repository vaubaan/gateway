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
import { SUPABASE_ICON, SUPABASE_ICON_COLOR } from './icon.ts';
import { supabaseToolTitles } from './tool-titles.ts';
import { supabaseTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const supabaseCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const supabasePlugin = definePlugin({
  id: 'supabase',
  displayName: 'Supabase',
  icon: SUPABASE_ICON,
  iconColor: SUPABASE_ICON_COLOR,
  version: '5.0.2',
  description:
    'Postgres, storage, auth and edge functions of Supabase projects, through the Management API.',
  summary:
    'One account is one personal access token of the Management API, scoped to the organisation and the projects the missions need; one resource is one project (database, storage, auth and edge functions). Supabase runs one project per environment, so the owner of the account labels each project (staging, prod, …) and the permissions tied to an environment apply to the projects carrying that label.',
  manualRevocation:
    'Delete the token in Supabase, signed in as the account that created it: Account preferences, Access tokens.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/supabase.md',
  tools: supabaseTools,
  toolTitles: supabaseToolTitles,
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
export { MAX_DISCOVERED_PROJECTS, SUPABASE_API_BASE, projectUrl } from './execute.ts';
export {
  AUTH_CONFIG_PUBLIC_FIELDS,
  FUNCTION_SECRET_PUBLIC_FIELDS,
  REDACTED_VALUE,
  redactAuthConfig,
  redactFunctionSecrets,
} from './redact.ts';
export { supabaseBearerOf, verifySupabaseToken, SUPABASE_TOKEN_FIELD } from './credential.ts';
