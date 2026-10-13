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

import { definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyTemplate } from './classify.ts';
import { templateDataModel } from './data-model.ts';
import { discoverTemplateResources, executeTemplate } from './execute.ts';
import { templateTools } from './tools.ts';

export const templateCatalog = loadCatalogFile(new URL('./risk-catalog.yaml', import.meta.url));

export const templatePlugin = definePlugin({
  id: 'template',
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
        name: 'api_key',
        label: 'API key',
        secret: true,
        help: 'Create a key with read and write access to the workspaces you want to connect.',
      },
    ],
  },
  classify: classifyTemplate,
  execute: executeTemplate,
  discoverResources: discoverTemplateResources,
});

export { classifyTemplate, templateDataModel, templateTools };
