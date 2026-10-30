/**
 * Identity of the `caldav` provider — the one place its ids are written.
 *
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md (D5).
 * Handbook : docs/handbook/providers/caldav.md.
 *
 * Everything else — the data-model provider, the tool names, the resources
 * `discoverResources` returns, the credential fields — derives from this
 * module, so a classifier can never emit slices under one provider while the
 * executor filters resources under another.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The provider id. */
export const CALDAV_PLUGIN_ID = 'caldav';

/** The version, equal to `package.json` (telemetry reports it). */
export const CALDAV_PLUGIN_VERSION = '0.1.1';

export const CALDAV_TOOL_PREFIX = toolPrefixFor(CALDAV_PLUGIN_ID);

/** The MCP tool names. Declared in `tools.ts`, dispatched in `classify.ts` and `execute.ts`. */
export const TOOL = {
  listCalendars: `${CALDAV_TOOL_PREFIX}list_calendars`,
  listEvents: `${CALDAV_TOOL_PREFIX}list_events`,
  getEvent: `${CALDAV_TOOL_PREFIX}get_event`,
  createEvent: `${CALDAV_TOOL_PREFIX}create_event`,
  updateEvent: `${CALDAV_TOOL_PREFIX}update_event`,
  deleteEvent: `${CALDAV_TOOL_PREFIX}delete_event`,
} as const;

/** The six tools the classifier knows. Any other name is `denied`. */
export const CALDAV_TOOLS: readonly string[] = Object.values(TOOL);

/** The three form fields of the credential, keyed by `CredentialField.name`. */
export const CALDAV_FIELDS = {
  serverUrl: 'server_url',
  username: 'username',
  appPassword: 'app_password',
} as const;
