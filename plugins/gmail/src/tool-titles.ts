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

export const gmailToolTitles: Readonly<Record<string, string>> = {
  gmail__describe_zones: 'Show how the mailbox is zoned',
  gmail__search_threads: 'Search the mailbox',
  gmail__get_thread: 'Read a thread',
  gmail__get_attachment: 'Download an attachment',
  gmail__list_drafts: 'List the drafts',
  gmail__create_draft: 'Save a draft (never sent)',
  gmail__list_labels: 'List the labels',
  gmail__create_label: 'Create a label',
  gmail__label_message: 'Add a label to a message',
  gmail__unlabel_message: 'Remove a label from a message',
  gmail__label_thread: 'Add a label to a thread',
  gmail__unlabel_thread: 'Remove a label from a thread',
};
