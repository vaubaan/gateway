/**
 * `@vaubaan/plugin-template` — the scaffold every provider plugin starts from.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Guide : plugins/README.md ; docs/handbook/plugin-sdk.md.
 *
 * A plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time : id grammar, tool prefixes, catalog provider,
 * presets, data-model integrity, credential spec. The YAML catalog is loaded
 * here, once, when the module is first imported (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyTemplate } from './classify.ts';
import { templateDataModel } from './data-model.ts';
import { discoverTemplateResources, executeTemplate } from './execute.ts';
import { API_KEY_FIELD, PROVIDER_ID } from './identity.ts';
import { templateTools } from './tools.ts';

// `catalogPathNextTo` builds a filesystem path from `import.meta.url` ; never
// write `new URL('./risk-catalog.yaml', import.meta.url)` here — the Next.js
// bundler rewrites that literal into a static asset and the YAML cannot be
// read at boot (ADR plugin-catalog-path-and-standalone-tracing).
export const templateCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const templatePlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Template provider',
  version: '0.1.0',
  description: 'Scaffold plugin. Copy it to start a real one.',
  tools: templateTools,
  dataModel: templateDataModel,
  catalog: templateCatalog.catalog,
  credential: {
    kind: 'api-key',
    fields: [
      {
        name: API_KEY_FIELD,
        label: 'API key',
        secret: true,
        help: 'Create a key with read and write access to the workspaces you want to connect.',
      },
    ],
  },
  classify: classifyTemplate,
  // The environment of a `template` call is the owner's label on the
  // workspace resource, so no `envOf` hook is needed. A provider whose data
  // model names the environment in the slice (`vercel.project[p].env[prod]…`)
  // declares `envOf: envFromSliceSegment('env')` here instead.
  execute: executeTemplate,
  discoverResources: discoverTemplateResources,
});

export { classifyTemplate, templateDataModel, templateTools };
export { API_KEY_FIELD, PROVIDER_ID, TOOL } from './identity.ts';
