/**
 * `@vaubaan/plugin-google-calendar` — Google Calendar, through Google's
 * official Calendar MCP server, with an access token from the OAuth broker
 * the instance is enrolled with.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md (D3, D4).
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
import { PROVIDER_ID } from './identity.ts';
import { googleCalendarToolTitles } from './tool-titles.ts';
import { googleCalendarTools } from './tools.ts';

// `catalogPathNextTo` keeps the path a filesystem path the bundler leaves alone
// (ADR plugin-catalog-path-and-standalone-tracing).
export const googleCalendarCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const googleCalendarPlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Google Calendar',
  icon: GOOGLE_CALENDAR_ICON,
  iconColor: GOOGLE_CALENDAR_ICON_COLOR,
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.1.0',
  description:
    "Google Calendar through Google's own Calendar MCP server: read the agenda, suggest a time, create, change and delete events, answer invitations — one resource per calendar.",
  summary:
    "One account is one Google account: you sign in at Google through the OAuth broker this gateway is enrolled with, with nothing to create or paste. One resource is one calendar of that account; a mission touches only the calendars it was given. Inviting people of the company and people outside it are separate permissions, decided by each calendar's internal domains, and so are letting Google email the guests of a change, and deleting.",
  manualRevocation:
    "In your Google account, open Security, then 'Third-party apps with account access', and remove the app this gateway signed you in with.",
  docsUrl:
    'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/google-calendar.md',
  tools: googleCalendarTools,
  toolTitles: googleCalendarToolTitles,
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
  readCalendarCall,
  resolveCalendar,
  zoneOf,
  type CalendarCall,
  type GuestZone,
} from './call.ts';
export { slicesOf } from './classify.ts';
export { REQUIRED_SCOPES, googleCalendarCredential } from './credential.ts';
export {
  DISCOVERY_PAGE_SIZE,
  MAX_DISCOVERED_CALENDARS,
  MCP_SERVER_REFUSED,
  calendarsIn,
  discoverGoogleCalendarResources,
  executeGoogleCalendar,
  resourcesOf,
  toolDrift,
  toolResultOf,
  type FoundCalendar,
  type ToolDrift,
} from './execute.ts';
export {
  CALENDAR_ID,
  CALENDAR_REF,
  EVENT_ID,
  calendarIdOf,
  calendarRefFromArgument,
  calendarRefOf,
  eventId,
  parseAddress,
} from './identifiers.ts';
export {
  BROKER_PROVIDER,
  CALENDAR_MCP_URL,
  LOCATOR,
  PROVIDER_ID,
  SCOPES,
  TOOL,
  UPSTREAM_TOOL,
  WITHHELD_ARGUMENTS,
} from './identity.ts';
export { MCP_PROTOCOL_VERSION, firstJsonRpcFrame, mcpRequest } from './mcp.ts';
export {
  MODELLED_LOCATING_ARGUMENTS,
  UPSTREAM_TOOL_LIST,
  declarationsOf,
  readUpstreamToolList,
  unmodelledLocators,
  upstreamToolOf,
} from './tools.ts';
