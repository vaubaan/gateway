/**
 * What each tool of the `caldav` service does, in a few words a person reads
 * at a glance (`ServicePlugin.toolTitles`) : the head of an approval request
 * in the web interface. For people only : never part of `tools/list`.
 */

import { TOOL } from './identity.ts';

export const caldavToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listCalendars]: 'List the calendars',
  [TOOL.listEvents]: 'List the events of a time range',
  [TOOL.getEvent]: 'Read an event',
  [TOOL.createEvent]: 'Create an event',
  [TOOL.updateEvent]: 'Change an event',
  [TOOL.deleteEvent]: 'Delete an event',
};
