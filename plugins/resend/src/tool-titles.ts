/**
 * What each tool of the `resend` provider does, in a few words a person reads at
 * a glance (`ProviderPlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

import { TOOL } from './identity.ts';

export const resendToolTitles: Readonly<Record<string, string>> = {
  [TOOL.getEmail]: 'Read the status of a sent email',
  [TOOL.listDomains]: 'List sending domains',
  [TOOL.getDomain]: 'Read a sending domain',
  [TOOL.listSegments]: 'List segments',
  [TOOL.getSegment]: 'Read a segment',
  [TOOL.listContacts]: 'List contacts',
  [TOOL.getContact]: 'Read a contact',
  [TOOL.listBroadcasts]: 'List broadcasts',
  [TOOL.getBroadcast]: 'Read a broadcast',
  [TOOL.describeZones]: 'Read the recipient zones',
  [TOOL.sendEmail]: 'Send an email',
  [TOOL.sendBatchEmails]: 'Send a batch of emails',
  [TOOL.createDomain]: 'Add a sending domain',
  [TOOL.updateDomain]: 'Change a sending domain',
  [TOOL.deleteDomain]: 'Remove a sending domain',
  [TOOL.verifyDomain]: 'Re-check a sending domain',
  [TOOL.createSegment]: 'Create a segment',
  [TOOL.deleteSegment]: 'Delete a segment',
  [TOOL.createContact]: 'Create a contact',
  [TOOL.updateContact]: 'Change a contact',
  [TOOL.deleteContact]: 'Delete a contact',
  [TOOL.addContactToSegment]: 'Add a contact to a segment',
  [TOOL.removeContactFromSegment]: 'Remove a contact from a segment',
  [TOOL.createBroadcast]: 'Create a draft broadcast',
  [TOOL.updateBroadcast]: 'Change a draft broadcast',
  [TOOL.sendBroadcast]: 'Send a broadcast to its segment',
  [TOOL.deleteBroadcast]: 'Delete a broadcast',
};
