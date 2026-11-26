/**
 * `@vaubaan/plugin-outlook` — mail and calendar of a Microsoft 365 or
 * Outlook.com account, through Microsoft Graph v1.0, with an access token
 * from the OAuth broker the instance is enrolled with.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/outlook-through-the-oauth-broker-microsoft-provider.md.
 * Handbook : docs/handbook/services/outlook.md ; guide : plugins/outlook/README.md.
 *
 * Credential : `oauth2` whose client is the broker's (`broker: { provider:
 * 'microsoft' }`). Discovery yields one resource, the account's mailbox. The
 * YAML catalog is loaded here, once, at import.
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyOutlook } from './classify.ts';
import { outlookCredential } from './credential.ts';
import { outlookDataModel } from './data-model.ts';
import { discoverOutlookResources, executeOutlook } from './execute.ts';
import { outlookExamples } from './examples.ts';
import { OUTLOOK_ICON, OUTLOOK_ICON_COLOR } from './icon.ts';
import { EXCLUDED_TOOLS, SERVICE_ID } from './identity.ts';
import { outlookToolTitles } from './tool-titles.ts';
import { outlookTools } from './tools.ts';

// `catalogPathNextTo` keeps the path a filesystem path the bundler leaves alone
// (docs/handbook/plugin-sdk.md).
export const outlookCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const outlookPlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'Outlook',
  icon: OUTLOOK_ICON,
  iconColor: OUTLOOK_ICON_COLOR,
  resourceNoun: { one: 'mailbox', other: 'mailboxes' },
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.1.3',
  description:
    'Mail and calendar of a Microsoft 365 or Outlook.com account, through Microsoft Graph',
  summary:
    "One account is one Microsoft 365 or Outlook.com account: you sign in at Microsoft through the OAuth broker this gateway is enrolled with, with nothing to create or paste. Its one resource is the account's mailbox, which also holds its calendars. Reads are priced by who sent the mail, drafts and sends by who receives them, invitations by who is invited; a draft to an address outside the internal domains and the allowlists is refused, and a send there is its own permission, external and irreversible.",
  manualRevocation:
    "In your Microsoft account, under Privacy → App access (personal accounts) or My Apps → manage apps (work accounts), remove the gateway's app.",
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/outlook.md',
  tools: outlookTools,
  toolTitles: outlookToolTitles,
  excludedTools: EXCLUDED_TOOLS,
  examples: outlookExamples,
  dataModel: outlookDataModel,
  catalog: outlookCatalog.catalog,
  credential: outlookCredential,
  classify: classifyOutlook,
  execute: executeOutlook,
  discoverResources: discoverOutlookResources,
});

// The gateway registers a plugin through its default export.
export default outlookPlugin;

export { classifyOutlook, slicesOf } from './classify.ts';
export { NO_MAILBOX, readOutlookCall, resolveMailbox, type OutlookCall } from './call.ts';
export {
  REQUESTED_SCOPES,
  REQUIRED_PERMISSIONS,
  missingScopes,
  outlookCredential,
  scopesNotGrantedMessage,
} from './credential.ts';
export {
  CONSUMER_DOMAINS,
  discoverOutlookResources,
  executeOutlook,
  mailboxResource,
} from './execute.ts';
export { folderRef, graphId, mailboxRefOf, pathSegment } from './identifiers.ts';
export {
  BARE_TOOL,
  BROKER_PROVIDER,
  EXCLUDED_TOOLS,
  GRAPH_API_BASE,
  SERVICE_ID,
  SCOPES,
  TOOL,
} from './identity.ts';
export { parseQuery, type ParsedQuery } from './q-parser.ts';
export { outlookDataModel, outlookToolTitles, outlookTools };
export { EXAMPLE_MAILBOX, outlookExamples } from './examples.ts';
