/**
 * `@vaubaan/plugin-asana` — the Asana plugin.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/services/asana.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. The YAML catalog is loaded
 * here, once, when the module is first imported (at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyAsana } from './classify.ts';
import { asanaCredential } from './credential.ts';
import { asanaDataModel } from './data-model.ts';
import { discoverAsanaResources } from './discovery.ts';
import { executeAsana } from './execute.ts';
import { asanaExamples } from './examples.ts';
import { ASANA_ICON, ASANA_ICON_COLOR } from './icon.ts';
import { SERVICE_ID } from './identity.ts';
import { asanaToolTitles, asanaTools } from './tools.ts';

// A filesystem path next to this module (docs/handbook/plugin-sdk.md).
export const asanaCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const asanaPlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'Asana',
  icon: ASANA_ICON,
  iconColor: ASANA_ICON_COLOR,
  resourceNoun: { one: 'project', other: 'projects' },
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.1.0',
  description:
    'Read the projects, sections, tasks and comments of an Asana account; create, change, comment on and delete tasks.',
  summary:
    'One account is one Asana user, connected with a personal access token: it acts as that person and signs everything with their name. One resource is one project the account can see, with its sections, tasks, subtasks and comments; tasks in no project (My tasks only) are out of reach. Asana has no environments: deleting a task is a permission of its own.',
  manualRevocation:
    'Open the Asana developer console (My apps, Personal access tokens) and delete the token named for this gateway.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/asana.md',
  tools: asanaTools,
  toolTitles: asanaToolTitles,
  examples: asanaExamples,
  dataModel: asanaDataModel,
  catalog: asanaCatalog.catalog,
  credential: asanaCredential,
  classify: classifyAsana,
  // No environment : no `envOf` hook, no env-scoped risk.
  execute: executeAsana,
  discoverResources: discoverAsanaResources,
});

export default asanaPlugin;

export { classifyAsana, discoverAsanaResources, executeAsana, asanaDataModel, asanaTools };
export { readCall, resolveProject } from './call.ts';
export { slicesOf } from './classify.ts';
export { ASANA_API_BASE } from './api.ts';
export { ASANA_DEVELOPER_CONSOLE, asanaCredential, verifyAsanaToken } from './credential.ts';
export { MAX_PROJECTS } from './discovery.ts';
export { MAX_COMMENT_PAGES, MAX_SECTION_PAGES } from './execute.ts';
export { MAX_PARENT_DEPTH } from './membership.ts';
export { asanaGid, offsetToken } from './ids.ts';
export { PAT_FIELD, SERVICE_ID, TOOL, TOOL_PREFIX } from './identity.ts';
export { EXAMPLE_OTHER_PROJECT, EXAMPLE_PROJECT, asanaExamples } from './examples.ts';
