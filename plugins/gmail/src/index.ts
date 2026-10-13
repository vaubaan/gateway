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
 *
 * The legacy v4 exports at the bottom keep the v4 application compiling until
 * P1.6 replaces its last consumers with the registry.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { definePlugin, loadCatalogFile, type ProviderPlugin } from '@vaubaan/plugin-sdk';

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
  refreshGmailCredential,
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

// The path is built with `node:path` from `import.meta.url`, not with
// `new URL('./risk-catalog.yaml', import.meta.url)` : Turbopack (apps/gateway)
// rewrites that literal into a static asset URL and the YAML can no longer be
// read at boot. An SDK helper replaces this in P1.2-SDK.
export const gmailCatalog = loadCatalogFile(
  join(dirname(fileURLToPath(import.meta.url)), 'risk-catalog.yaml'),
);

/**
 * Marks a plugin the host must treat as experimental : hidden from the
 * default connect / issuance flows, tools not listed. The SDK contract has no
 * such flag yet ; this plugin carries it as an extra, typed member until
 * `ProviderPlugin` gains one (reported to P1.2-SDK).
 */
export interface ExperimentalPluginFlag {
  readonly experimental: true;
}

export type GmailPlugin = ProviderPlugin & ExperimentalPluginFlag;

export const gmailPlugin: GmailPlugin = definePlugin<GmailPlugin>({
  id: GMAIL_PLUGIN_ID,
  displayName: 'Gmail',
  version: '0.1.0',
  description:
    'Experimental, classifier-only : identity-zoned risks for reading, drafting and labelling in a Gmail mailbox. No tool is executable yet.',
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
  refresh: refreshGmailCredential,
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
  refreshGmailCredential,
  selectMailbox,
};
export type { FromZone, GmailMailboxMetadata, ToZone } from './classify.ts';
export type { GmailClassifiedTool } from './tools.ts';
export { parseQ as parseGmailQ } from './q-parser.ts';
export type { QParsed as GmailQParsed } from './q-parser.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Legacy v4 exports — consumed by apps/gateway until P1.6 ; deleted with it.
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated legacy v4, deleted in P1.6 — use `gmailPlugin.catalog`. */
export const gmailRiskCatalog = gmailCatalog.catalog;
/** @deprecated legacy v4, deleted in P1.6 — use `gmailPlugin.tools`. */
export { gmailTools as gmailAvailableTools } from './tools.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `gmailPlugin.classify`. */
export { classifyGmailV4 } from './risk-classifier.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK. */
export type { ClassifyResult as GmailClassifyV4Result } from './risk-classifier.ts';
