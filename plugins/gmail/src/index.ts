/**
 * `@vaubaan/plugin-gmail` — the Gmail provider plugin. **Experimental,
 * classifier-only** : it classifies the ten modelled tools into the risks of
 * its catalog and discovers the mailbox, but exposes no tool and executes
 * nothing (see `execute.ts`).
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/gmail.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time ; the YAML catalog is loaded here, once, when the
 * module is first imported (that is, at gateway boot).
 */

import {
  catalogPathNextTo,
  definePlugin,
  loadCatalogFile,
  type ProviderPlugin,
} from '@vaubaan/plugin-sdk';

import {
  GMAIL_METADATA_KEYS,
  classifyFromAddress,
  classifyGmail,
  classifyRecipients,
  readMailboxMetadata,
  selectMailbox,
} from './classify.ts';
import {
  GMAIL_API_BASE,
  GMAIL_APP_CONFIG_KEYS,
  GMAIL_AUTHORIZATION_URL,
  GMAIL_SCOPE_COMPOSE,
  GMAIL_SCOPE_READONLY,
  GMAIL_SCOPES,
  GMAIL_TOKEN_URL,
  gmailCredentialSpec,
} from './credential.ts';
import { gmailDataModel } from './data-model.ts';
import {
  GMAIL_NOT_IMPLEMENTED_CODE,
  GMAIL_PLUGIN_ID,
  discoverGmailResources,
  executeGmail,
} from './execute.ts';
import {
  GMAIL_CLASSIFIED_TOOLS,
  GMAIL_TOOL_PREFIX,
  gmailClassifiedToolDeclarations,
  gmailTools,
} from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const gmailCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const gmailPlugin: ProviderPlugin = definePlugin({
  id: GMAIL_PLUGIN_ID,
  displayName: 'Gmail',
  version: '0.2.0',
  description:
    'Experimental, classifier-only : identity-zoned risks for reading, drafting and labelling in a Gmail mailbox. No tool is executable yet.',
  summary:
    'Experimental. One connection is one Gmail mailbox, which is also its single resource. The plugin models the risks of reading, drafting and labelling by who the sender or the recipient is, but it executes nothing yet: no tool is offered to agents.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/gmail.md',
  experimental: true,
  tools: gmailTools,
  dataModel: gmailDataModel,
  catalog: gmailCatalog.catalog,
  credential: gmailCredentialSpec,
  classify: classifyGmail,
  execute: executeGmail,
  discoverResources: discoverGmailResources,
});

export default gmailPlugin;

export {
  GMAIL_API_BASE,
  GMAIL_APP_CONFIG_KEYS,
  GMAIL_AUTHORIZATION_URL,
  GMAIL_CLASSIFIED_TOOLS,
  GMAIL_METADATA_KEYS,
  GMAIL_NOT_IMPLEMENTED_CODE,
  GMAIL_PLUGIN_ID,
  GMAIL_SCOPE_COMPOSE,
  GMAIL_SCOPE_READONLY,
  GMAIL_SCOPES,
  GMAIL_TOKEN_URL,
  GMAIL_TOOL_PREFIX,
  classifyFromAddress,
  classifyGmail,
  classifyRecipients,
  discoverGmailResources,
  executeGmail,
  gmailClassifiedToolDeclarations,
  gmailCredentialSpec,
  gmailDataModel,
  gmailTools,
  readMailboxMetadata,
  selectMailbox,
};
export type { FromZone, GmailMailboxMetadata, ToZone } from './classify.ts';
export type { GmailClassifiedTool } from './tools.ts';
export { parseQ as parseGmailQ } from './q-parser.ts';
export type { QParsed as GmailQParsed } from './q-parser.ts';
