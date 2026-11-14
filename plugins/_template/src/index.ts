/**
 * `@vaubaan/plugin-template` — the scaffold every provider plugin starts from.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Guide : plugins/README.md ; docs/handbook/plugin-sdk.md.
 *
 * A plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time : id grammar, tool prefixes, catalog provider,
 * macro-actions, data-model integrity, credential spec. The YAML catalog is loaded
 * here, once, when the module is first imported (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyTemplate } from './classify.ts';
import { templateCredential } from './credential.ts';
import { templateDataModel } from './data-model.ts';
import { discoverTemplateResources, executeTemplate } from './execute.ts';
import { templateExamples } from './examples.ts';
import { _TEMPLATE_ICON, _TEMPLATE_ICON_COLOR } from './icon.ts';
import { PROVIDER_ID } from './identity.ts';
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
  // What one resource is called in the interface ("3 workspaces"); optional.
  resourceNoun: { one: 'workspace', other: 'workspaces' },
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.2.0',
  description: 'Scaffold plugin. Copy it to start a real one.',
  // The paragraph of the provider reference (`/providers/<id>`), in plain words: what one
  // account is, what one resource is, where the environment of a call comes from.
  summary:
    'One account is one API key of the template service; one resource is one workspace. The owner of the account labels each workspace with an environment (staging, prod), and writes are held per label.',
  manualRevocation: "Delete the API key in the service's dashboard.",
  // Add `docsUrl` once the provider handbook exists (docs/handbook/providers/<id>.md).
  tools: templateTools,
  // What each tool does, in a few words : the head of an approval request in the web
  // interface ("Delete a widget · <workspace>"). Optional ; a tool without one is shown by its name.
  toolTitles: templateToolTitles,
  // Tools of the provider this plugin deliberately does not expose, one sentence each,
  // shown on its public page; never a declared tool, and `classify` refuses the name.
  // Optional : declare it when the risk model leaves a tool out (risk model §7.2).
  // excludedTools: { <a tool name written in identity.ts>: '<why, in one sentence>' },
  // Representative calls of every tool (`examples.ts`) : what the tests run through the kit
  // and the site classifies to show worked calls.
  examples: templateExamples,
  dataModel: templateDataModel,
  catalog: templateCatalog.catalog,
  // How an account of this provider is obtained : the one way, the
  // simplest the provider offers — a key a person makes by hand whenever the
  // provider has one. The host runs the flow from this declaration (here : a
  // form with one secret field) ; the plugin writes no route and never reads
  // the environment. The other kinds — `oauth2` (only where the provider has
  // no token a person can make), `ssh-key` — are in plugins/README.md, step 5.
  // An `api-key` way carries its guide and its check at paste (`credential.ts`).
  credential: templateCredential,
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
export {
  TEMPLATE_KEYS_PAGE,
  TEMPLATE_KEY_PERMISSIONS,
  templateCredential,
  verifyTemplateKey,
} from './credential.ts';
export { TEMPLATE_API_BASE, discoverTemplateResources, executeTemplate } from './execute.ts';
export { API_KEY_FIELD, PROVIDER_ID, TOOL } from './identity.ts';
export { EXAMPLE_PROD, EXAMPLE_STAGING, templateExamples } from './examples.ts';
