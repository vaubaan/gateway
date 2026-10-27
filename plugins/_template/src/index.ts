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
import { _TEMPLATE_ICON, _TEMPLATE_ICON_COLOR } from './icon.ts';
import { API_KEY_FIELD, PROVIDER_ID } from './identity.ts';
import { templateTools, templateToolTitles } from './tools.ts';

// `catalogPathNextTo` builds a filesystem path from `import.meta.url` ; never
// write `new URL('./risk-catalog.yaml', import.meta.url)` here — the Next.js
// bundler rewrites that literal into a static asset and the YAML cannot be
// read at boot (docs/handbook/plugin-sdk.md).
export const templateCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const templatePlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Template provider',
  icon: _TEMPLATE_ICON,
  iconColor: _TEMPLATE_ICON_COLOR,
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.1.1',
  description: 'Scaffold plugin. Copy it to start a real one.',
  // The paragraph of the provider reference (`/providers/<id>`), in plain words: what one
  // connection is, what one resource is, where the environment of a call comes from.
  summary:
    'One account is one API key of the template service; one resource is one workspace. The owner of the account labels each workspace with an environment (staging, prod), and writes are held per label.',
  manualRevocation: "Delete the API key in the service's dashboard.",
  // Add `docsUrl` once the provider handbook exists (docs/handbook/providers/<id>.md).
  tools: templateTools,
  // What each tool does, in a few words : the head of an approval request in the web
  // interface ("Delete a widget · <workspace>"). Optional ; a tool without one is shown by its name.
  toolTitles: templateToolTitles,
  dataModel: templateDataModel,
  catalog: templateCatalog.catalog,
  // How a connection of this provider is obtained : the one way, the
  // simplest the provider offers — a key a person makes by hand whenever the
  // provider has one. The host runs the flow from this declaration (here : a
  // form with one secret field) ; the plugin writes no route and never reads
  // the environment. The other kinds — `oauth2` (only where the provider has
  // no token a person can make), `ssh-key` — are in plugins/README.md, step 5.
  credential: {
    kind: 'api-key',
    // Where the user creates the key ; shown as a link next to the form.
    createUrl: 'https://example.com/settings/api-keys',
    fields: [
      {
        name: API_KEY_FIELD,
        label: 'API key',
        secret: true,
        required: true,
        placeholder: 'Template API key',
        // Checked by the host before any call : a value that cannot be a key
        // of this provider is refused at the form.
        pattern: '^[A-Za-z0-9_-]{8,}$',
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

// The gateway registers a plugin through its default export
// (apps/gateway/src/server/compose/shipped-plugins.ts).
export default templatePlugin;

export { classifyTemplate, templateDataModel, templateTools };
export { MALFORMED_WIDGET_ID, PATH_IDENT, pathIdent, resolveWorkspace } from './classify.ts';
export { TEMPLATE_API_BASE, discoverTemplateResources, executeTemplate } from './execute.ts';
export { API_KEY_FIELD, PROVIDER_ID, TOOL } from './identity.ts';
