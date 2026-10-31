/**
 * Identity of the `gmail` provider — the one place its ids are written.
 *
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * `PROVIDER_ID` is also written as `provider:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model provider, the slices, the credential kind check,
 * the mailbox resource, the tool names — is derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The provider id. */
export const PROVIDER_ID = 'gmail';

/** `gmail__` : the prefix of every tool name. */
export const TOOL_PREFIX = toolPrefixFor(PROVIDER_ID);

/**
 * The MCP tool names, in the order `tools/list` gives them : the synthetic
 * `describe_zones` (no upstream call), the IMAP reads, drafts, the two SMTP
 * sends, then labels.
 */
export const TOOL = {
  describeZones: `${TOOL_PREFIX}describe_zones`,
  searchThreads: `${TOOL_PREFIX}search_threads`,
  getThread: `${TOOL_PREFIX}get_thread`,
  getAttachment: `${TOOL_PREFIX}get_attachment`,
  listDrafts: `${TOOL_PREFIX}list_drafts`,
  createDraft: `${TOOL_PREFIX}create_draft`,
  sendMessage: `${TOOL_PREFIX}send_message`,
  sendDraft: `${TOOL_PREFIX}send_draft`,
  listLabels: `${TOOL_PREFIX}list_labels`,
  createLabel: `${TOOL_PREFIX}create_label`,
  labelMessage: `${TOOL_PREFIX}label_message`,
  unlabelMessage: `${TOOL_PREFIX}unlabel_message`,
  labelThread: `${TOOL_PREFIX}label_thread`,
  unlabelThread: `${TOOL_PREFIX}unlabel_thread`,
} as const;

/** A tool name of the plugin. */
export type GmailTool = (typeof TOOL)[keyof typeof TOOL];
