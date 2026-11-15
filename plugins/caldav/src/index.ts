/**
 * `@vaubaan/plugin-caldav` — "CalDAV Calendar", the generic calendar plugin :
 * any CalDAV server (iCloud, Fastmail, Nextcloud, …) reached with a username
 * and an app password. Lists calendars and events, reads, creates, changes
 * and deletes events, under risks zoned by who the attendees are.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md (D5).
 * Handbook : docs/handbook/services/caldav.md ; guide : plugins/README.md.
 *
 * Google is not reachable through it (Google refuses Basic authentication) :
 * Google Calendar is the `google-calendar` plugin. `createCaldavPlugin({ now,
 * uuid })` builds the same plugin with a pinned clock and identifiers for tests.
 */

import {
  catalogPathNextTo,
  definePlugin,
  loadCatalogFile,
  type ServicePlugin,
} from '@vaubaan/plugin-sdk';

import { classifyCaldav } from './classify.ts';
import { caldavDataModel } from './data-model.ts';
import { caldavExamples } from './examples.ts';
import { createCaldavRuntime, type CaldavRuntimeOptions } from './execute.ts';
import { CALDAV_ICON, CALDAV_ICON_COLOR } from './icon.ts';
import { CALDAV_PLUGIN_ID, CALDAV_PLUGIN_VERSION } from './identity.ts';
import { caldavToolTitles } from './tool-titles.ts';
import { caldavTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const caldavCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export function createCaldavPlugin(options: CaldavRuntimeOptions = {}): ServicePlugin {
  const runtime = createCaldavRuntime(options);
  return definePlugin({
    id: CALDAV_PLUGIN_ID,
    displayName: 'CalDAV Calendar',
    icon: CALDAV_ICON,
    iconColor: CALDAV_ICON_COLOR,
    resourceNoun: { one: 'calendar', other: 'calendars' },
    version: CALDAV_PLUGIN_VERSION,
    description:
      'Calendars on any CalDAV server (iCloud, Fastmail, Nextcloud…), connected with an app password: list calendars and events, read, create, change and delete events, under risks zoned by who the attendees are. Not for Google Calendar.',
    summary:
      'One account is one CalDAV account (a server URL, a username and an app password); each calendar that stores events is a resource. Reads are priced by the length of the time range; writes by whether they create, change or delete an event, and by who the server may notify: attendees inside the company domains, on the allowlist, or outside. Google Calendar is a separate service.',
    manualRevocation:
      'Delete the app password named "Vaubaan Gateway" at the calendar service: iCloud at account.apple.com (Sign-In and Security, App-Specific Passwords), Fastmail under Settings, Privacy & Security, Nextcloud under Personal settings, Security.',
    docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/caldav.md',
    tools: caldavTools,
    toolTitles: caldavToolTitles,
    examples: caldavExamples,
    dataModel: caldavDataModel,
    catalog: caldavCatalog.catalog,
    credential: runtime.credential,
    classify: classifyCaldav,
    execute: runtime.execute,
    discoverResources: runtime.discoverResources,
  });
}

export const caldavPlugin: ServicePlugin = createCaldavPlugin();

export default caldavPlugin;

export {
  CALDAV_METADATA_KEYS,
  calendarRef,
  classifyCaldav,
  etagValue,
  eventId,
  readEventInput,
  readZoning,
  resolveCalendar,
  zoneOf,
} from './classify.ts';
export type { AttendeeZone, CalendarZoning, EventInput } from './classify.ts';
export {
  GOOGLE_REFUSAL,
  caldavAccount,
  caldavCredentialFields,
  caldavGuide,
  normalizeServerUrl,
} from './credential.ts';
export { caldavDataModel } from './data-model.ts';
export { caldavExamples, EXAMPLE_HOME_CALENDAR, EXAMPLE_WORK_CALENDAR } from './examples.ts';
export { isAllowedTarget, parseMultistatus } from './dav.ts';
export type { DavAccount } from './dav.ts';
export { buildEvent, eventView } from './event.ts';
export type { EventView } from './event.ts';
export { createCaldavRuntime, digestRef } from './execute.ts';
export type { CaldavRuntime, CaldavRuntimeOptions } from './execute.ts';
export { escapeText, foldLine, parseIcs, serializeIcs, unescapeText } from './ical.ts';
export {
  CALDAV_FIELDS,
  CALDAV_PLUGIN_ID,
  CALDAV_PLUGIN_VERSION,
  CALDAV_TOOLS,
  TOOL,
} from './identity.ts';
export { caldavToolTitles } from './tool-titles.ts';
export { caldavTools } from './tools.ts';
