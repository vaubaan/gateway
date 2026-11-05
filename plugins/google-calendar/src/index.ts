/**
 * `@vaubaan/plugin-google-calendar` — Google Calendar, through Google's
 * public Calendar REST API v3, with an access token from the OAuth broker
 * the instance is enrolled with.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md.
 * Handbook : docs/handbook/providers/google-calendar.md ; guide : plugins/google-calendar/README.md.
 *
 * Credential : `oauth2` whose client is the broker's (`broker: { provider:
 * 'google' }`). Discovery yields one resource per calendar of the account.
 * The YAML catalog is loaded here, once, at import.
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyGoogleCalendar } from './classify.ts';
import { googleCalendarCredential } from './credential.ts';
import { googleCalendarDataModel } from './data-model.ts';
import { discoverGoogleCalendarResources, executeGoogleCalendar } from './execute.ts';
import { GOOGLE_CALENDAR_ICON, GOOGLE_CALENDAR_ICON_COLOR } from './icon.ts';
import { googleCalendarExamples } from './examples.ts';
import { PROVIDER_ID } from './identity.ts';
import { googleCalendarToolTitles } from './tool-titles.ts';
import { googleCalendarTools } from './tools.ts';

// `catalogPathNextTo` keeps the path a filesystem path the bundler leaves alone
// (docs/handbook/plugin-sdk.md).
export const googleCalendarCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const googleCalendarPlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Google Calendar',
  icon: GOOGLE_CALENDAR_ICON,
  iconColor: GOOGLE_CALENDAR_ICON_COLOR,
  resourceNoun: { one: 'calendar', other: 'calendars' },
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.4.0',
  description:
    "Google Calendar through Google's Calendar API: read the agenda, suggest a time, create, change and delete events, answer invitations — one resource per calendar.",
  summary:
    "One account is one Google account: you sign in at Google through the OAuth broker this gateway is enrolled with, with nothing to create or paste. One resource is one calendar of that account; a mission touches only the calendars it was given. Inviting people of the company and people outside it are separate permissions, decided by each calendar's internal domains, and so are letting Google email the guests of a change, and deleting.",
  manualRevocation:
    "In your Google account, open Security, then 'Third-party apps with account access', and remove the app this gateway signed you in with.",
  docsUrl:
    'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/google-calendar.md',
  tools: googleCalendarTools,
  toolTitles: googleCalendarToolTitles,
  examples: googleCalendarExamples,
  dataModel: googleCalendarDataModel,
  catalog: googleCalendarCatalog.catalog,
  credential: googleCalendarCredential,
  classify: classifyGoogleCalendar,
  execute: executeGoogleCalendar,
  discoverResources: discoverGoogleCalendarResources,
});

// The gateway registers a plugin through its default export.
export default googleCalendarPlugin;

export { classifyGoogleCalendar, googleCalendarDataModel, googleCalendarTools };
export { googleCalendarToolTitles };
export {
  NO_CALENDAR,
  calendarsOf,
  instantOf,
  readCalendarCall,
  resolveCalendar,
  zoneOf,
  type CalendarCall,
  type GuestZone,
} from './call.ts';
export { slicesOf } from './classify.ts';
export { EXAMPLE_PRIMARY, EXAMPLE_TEAM, googleCalendarExamples } from './examples.ts';
export { REQUIRED_SCOPES, googleCalendarCredential } from './credential.ts';
export {
  CALENDAR_API_REFUSED,
  DEFAULT_EVENTS_PER_PAGE,
  DISCOVERY_PAGE_SIZE,
  MAX_DISCOVERED_CALENDARS,
  calendarsIn,
  discoverGoogleCalendarResources,
  executeGoogleCalendar,
  googleErrorReason,
  mergedAttendees,
  resourcesOf,
  type FoundCalendar,
} from './execute.ts';
export { freeSlots, mergedBusy, type Span } from './free-slots.ts';
export {
  CALENDAR_ID,
  CALENDAR_REF,
  EVENT_ID,
  calendarIdOf,
  calendarRefFromArgument,
  calendarRefOf,
  eventId,
  parseAddress,
  pathSegment,
} from './identifiers.ts';
export {
  BARE_TOOL,
  BROKER_PROVIDER,
  CALENDAR_API_BASE,
  PROVIDER_ID,
  SCOPES,
  SEND_UPDATES,
  TOOL,
} from './identity.ts';
export { MAX_EVENTS_PER_PAGE, MAX_FREE_BUSY_PEOPLE } from './tools.ts';
