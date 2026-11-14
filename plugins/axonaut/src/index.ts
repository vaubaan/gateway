/**
 * `@vaubaan/plugin-axonaut` — the CRM and the sales documents of one Axonaut
 * account, on the v5 SDK.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/axonaut.md ; guide : plugins/axonaut/README.md.
 *
 * Credential : `api-key`, the key of one Axonaut user (`credential.ts`). One
 * resource per account: the Axonaut account the key opens. No environment:
 * Axonaut has no test mode, and every risk is account-scoped.
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyAxonaut } from './classify.ts';
import { axonautCredential } from './credential.ts';
import { axonautDataModel } from './data-model.ts';
import { discoverAxonautResources, executeAxonaut } from './execute.ts';
import { axonautExamples } from './examples.ts';
import { AXONAUT_ICON, AXONAUT_ICON_COLOR } from './icon.ts';
import { PROVIDER_ID } from './identity.ts';
import { axonautToolTitles, axonautTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const axonautCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const axonautPlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Axonaut',
  icon: AXONAUT_ICON,
  iconColor: AXONAUT_ICON_COLOR,
  resourceNoun: { one: 'account', other: 'accounts' },
  version: '0.1.0',
  description:
    'CRM and sales of an Axonaut account: companies, contacts, pipeline, quotations, ' +
    'invoices, payments, projects, tasks and tickets.',
  summary:
    'One account is the API key of one Axonaut user; its one resource is the Axonaut company account that key opens. Axonaut has no test mode, so no environment applies: the permissions say what a mission may read, change, invoice or delete there, and creating an invoice, which cannot be deleted, asks you first.',
  manualRevocation: 'Regenerate the API key in Axonaut, under Settings (Paramètres), API.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/axonaut.md',
  tools: axonautTools,
  toolTitles: axonautToolTitles,
  examples: axonautExamples,
  dataModel: axonautDataModel,
  catalog: axonautCatalog.catalog,
  credential: axonautCredential,
  classify: classifyAxonaut,
  execute: executeAxonaut,
  discoverResources: discoverAxonautResources,
});

export default axonautPlugin;

export { axonautDataModel, axonautTools, classifyAxonaut };
export { readCall, resolveAccount, type AxonautCall, type AxonautRequest } from './call.ts';
export {
  AXONAUT_API_DOCS,
  AXONAUT_SIGN_IN_PAGE,
  axonautCredential,
  verifyAxonautKey,
} from './credential.ts';
export {
  API_KEY_HEADER,
  AXONAUT_API_BASE,
  discoverAxonautResources,
  executeAxonaut,
  readMe,
} from './execute.ts';
export { AXONAUT_ID, axonautId } from './fields.ts';
export { API_KEY_FIELD, PROVIDER_ID, TOOL, TOOL_PREFIX } from './identity.ts';
export { EXAMPLE_ACCOUNT, EXAMPLE_OTHER_ACCOUNT, axonautExamples } from './examples.ts';
