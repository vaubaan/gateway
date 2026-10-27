/**
 * What each `google-calendar` tool does, in a few words a person reads at a
 * glance (`ProviderPlugin.toolTitles`): the head of an approval request,
 * before the calendar the call resolves to. For people only: never part of
 * `tools/list`.
 */

import { TOOL } from './identity.ts';

export const googleCalendarToolTitles: Readonly<Record<string, string>> = {
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
