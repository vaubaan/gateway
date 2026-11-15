/**
 * What each `outlook` tool does, in a few words a person reads at a glance
 * (`ServicePlugin.toolTitles`): the head of an approval request, before the
 * mailbox the call resolves to. For people only: never part of `tools/list`.
 */

import { TOOL } from './identity.ts';

export const outlookToolTitles: Readonly<Record<string, string>> = {
  [TOOL.describeZones]: 'Read the mailbox zoning',
  [TOOL.listFolders]: 'List mail folders',
  [TOOL.searchMessages]: 'Search messages',
  [TOOL.getMessage]: 'Read a message',
  [TOOL.listAttachments]: 'List the attachments of a message',
  [TOOL.getAttachment]: 'Download an attachment',
  [TOOL.listDrafts]: 'List drafts',
  [TOOL.createDraft]: 'Write a draft',
  [TOOL.createReplyDraft]: 'Write a reply draft',
  [TOOL.sendMessage]: 'Send a message',
  [TOOL.sendDraft]: 'Send a draft',
  [TOOL.moveMessage]: 'Move a message',
  [TOOL.updateMessage]: 'Mark, flag or categorise a message',
  [TOOL.createFolder]: 'Create a mail folder',
  [TOOL.listCalendars]: 'List the calendars',
  [TOOL.listEvents]: 'List events',
  [TOOL.searchEvents]: 'Search events',
  [TOOL.getEvent]: 'Read an event',
  [TOOL.suggestTime]: 'Suggest a time',
  [TOOL.createEvent]: 'Create an event',
  [TOOL.updateEvent]: 'Change an event',
  [TOOL.deleteEvent]: 'Delete an event',
  [TOOL.respondToEvent]: 'Answer an invitation',
};
