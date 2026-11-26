/**
 * `@vaubaan/plugin-gmail` — the Gmail plugin. It
 * classifies the fourteen tools into the identity-zoned risks of its catalog
 * and executes them over IMAP, and the two sends over SMTP, signed in with
 * the mailbox's app password.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/gmail-over-imap-with-an-app-password.md ;
 *            docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/services/gmail.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk`, `imapflow`, `nodemailer` and
 * `html-to-text` only. `definePlugin`
 * validates the definition at import time ; the YAML catalog is loaded here,
 * once, when the module is first imported (that is, at gateway boot).
 * `createGmailPlugin({ transport, smtp })` builds the same plugin over fake
 * transports for tests.
 */

import {
  catalogPathNextTo,
  definePlugin,
  loadCatalogFile,
  type ServicePlugin,
} from '@vaubaan/plugin-sdk';

import {
  GMAIL_METADATA_KEYS,
  classifyFromAddress,
  classifyGmail,
  classifyRecipients,
  creatableLabel,
  gmailId,
  gmailPartId,
  labelRef,
  readMailboxMetadata,
  selectMailbox,
  writableLabel,
} from './classify.ts';
import {
  GMAIL_APP_PASSWORDS_URL,
  GMAIL_FIELDS,
  GMAIL_IMAP_HOST,
  GMAIL_IMAP_PORT,
  gmailAccount,
  gmailCredentialFields,
  gmailGuide,
  normalizeAppPassword,
  type GmailAccount,
} from './credential.ts';
import { gmailDataModel } from './data-model.ts';
import { buildDraft, encodeHeaderValue, withoutBccHeader } from './draft.ts';
import {
  createGmailRuntime,
  hexToImapId,
  imapIdToHex,
  mailboxResource,
  userLabels,
  type GmailRuntimeOptions,
} from './execute.ts';
import { GMAIL_ICON, GMAIL_ICON_COLOR } from './icon.ts';
import { gmailExamples } from './examples.ts';
import { SERVICE_ID } from './identity.ts';
import { GMAIL_CLASSIFIED_TOOLS, gmailClassifiedToolDeclarations, gmailTools } from './tools.ts';
import { gmailToolTitles } from './tool-titles.ts';
import {
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  GmailSmtpError,
  createNodemailerSmtpTransport,
  nodemailerSmtpTransport,
  smtpError,
} from './smtp.ts';
import { htmlToText, MAX_HTML_BYTES } from './html.ts';
import {
  attachmentsOf,
  bodyPartOf,
  createImapflowTransport,
  imapflowTransport,
  textPartOf,
} from './transport.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const gmailCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const GMAIL_PLUGIN_VERSION = '2.0.1';

export function createGmailPlugin(options: GmailRuntimeOptions = {}): ServicePlugin {
  const runtime = createGmailRuntime(options);
  return definePlugin({
    id: SERVICE_ID,
    displayName: 'Gmail',
    icon: GMAIL_ICON,
    iconColor: GMAIL_ICON_COLOR,
    resourceNoun: { one: 'mailbox', other: 'mailboxes' },
    version: GMAIL_PLUGIN_VERSION,
    description:
      'Search, read (HTML and attachments included), draft, label and create labels in a Gmail mailbox over IMAP, and send messages and drafts over SMTP, with an app password, under risks zoned by who the sender or the recipient is.',
    summary:
      'One account is one Gmail or Google Workspace mailbox, connected with an app password and reached over IMAP, and over SMTP to send; the mailbox is its single resource. Reads are priced by who the sender is, drafts and sends by who the recipients are. A draft to an address outside the internal domains and the allowlists is refused; a send there is its own risk, external and irreversible.',
    manualRevocation: `Delete the app password named "Vaubaan Gateway" at ${GMAIL_APP_PASSWORDS_URL}, in the Google Account of the mailbox.`,
    docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/gmail.md',
    tools: gmailTools,
    toolTitles: gmailToolTitles,
    examples: gmailExamples,
    dataModel: gmailDataModel,
    catalog: gmailCatalog.catalog,
    credential: runtime.credential,
    classify: classifyGmail,
    execute: runtime.execute,
    discoverResources: runtime.discoverResources,
  });
}

export const gmailPlugin: ServicePlugin = createGmailPlugin();

/** The credential spec of the shipped plugin, `verify` bound to the real transport. */
export const gmailCredentialSpec = gmailPlugin.credential;

export default gmailPlugin;

export {
  MAX_HTML_BYTES,
  creatableLabel,
  gmailPartId,
  attachmentsOf,
  bodyPartOf,
  htmlToText,
  GMAIL_APP_PASSWORDS_URL,
  GMAIL_CLASSIFIED_TOOLS,
  GMAIL_FIELDS,
  GMAIL_IMAP_HOST,
  GMAIL_IMAP_PORT,
  GMAIL_METADATA_KEYS,
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  GmailSmtpError,
  buildDraft,
  classifyFromAddress,
  classifyGmail,
  classifyRecipients,
  createGmailRuntime,
  createImapflowTransport,
  createNodemailerSmtpTransport,
  encodeHeaderValue,
  gmailAccount,
  gmailClassifiedToolDeclarations,
  gmailCredentialFields,
  gmailDataModel,
  gmailGuide,
  gmailId,
  gmailToolTitles,
  gmailTools,
  hexToImapId,
  imapflowTransport,
  imapIdToHex,
  labelRef,
  mailboxResource,
  nodemailerSmtpTransport,
  normalizeAppPassword,
  readMailboxMetadata,
  selectMailbox,
  smtpError,
  textPartOf,
  userLabels,
  withoutBccHeader,
  writableLabel,
};
export type { FromZone, GmailMailboxMetadata, ToZone } from './classify.ts';
export type { GmailAccount };
export type { GmailRuntime, GmailRuntimeOptions } from './execute.ts';
export { SERVICE_ID, TOOL, TOOL_PREFIX } from './identity.ts';
export { EXAMPLE_MAILBOX, EXAMPLE_OTHER_MAILBOX, gmailExamples } from './examples.ts';
export type { GmailTool } from './identity.ts';
export type {
  GmailSmtpErrorCode,
  GmailSmtpTransport,
  SmtpClient,
  SmtpClientFactory,
  SmtpClientOptions,
  SmtpMail,
  SmtpReceipt,
} from './smtp.ts';
export type {
  GmailImapSession,
  GmailSessionOptions,
  GmailTransport,
  ImapAddress,
  ImapAttachment,
  ImapBody,
  ImapFetchOptions,
  ImapPartContent,
  ImapMailbox,
  ImapMessage,
  ImapSearch,
  ImapStore,
} from './transport.ts';
export { parseQ as parseGmailQ } from './q-parser.ts';
export type { QParsed as GmailQParsed } from './q-parser.ts';
