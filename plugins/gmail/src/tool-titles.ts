/**
 * What each tool of the `gmail` provider does, in a few words a person reads
 * at a glance (`ProviderPlugin.toolTitles`) : the head of an approval request
 * in the web interface. A verb and its object, sentence case, no final
 * period. For people only : never part of `tools/list`, and the host decides
 * nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

import { TOOL } from './identity.ts';

export const gmailToolTitles: Readonly<Record<string, string>> = {
  [TOOL.describeZones]: 'Show how the mailbox is zoned',
  [TOOL.searchThreads]: 'Search the mailbox',
  [TOOL.getThread]: 'Read a thread',
  [TOOL.getAttachment]: 'Download an attachment',
  [TOOL.listDrafts]: 'List the drafts',
  [TOOL.createDraft]: 'Save a draft (never sent)',
  [TOOL.sendMessage]: 'Send a message',
  [TOOL.sendDraft]: 'Send a draft',
  [TOOL.listLabels]: 'List the labels',
  [TOOL.createLabel]: 'Create a label',
  [TOOL.labelMessage]: 'Add a label to a message',
  [TOOL.unlabelMessage]: 'Remove a label from a message',
  [TOOL.labelThread]: 'Add a label to a thread',
  [TOOL.unlabelThread]: 'Remove a label from a thread',
};
