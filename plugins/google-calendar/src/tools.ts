/**
 * MCP tools of the `google-calendar` provider — a rewrap of Google's official
 * Calendar MCP server (`https://calendarmcp.googleapis.com/mcp/v1`).
 *
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md D4 ;
 *            docs/decisions/rewrap-official-mcps.md.
 * Handbook : docs/handbook/providers/google-calendar.md, Procedures.
 *
 * `upstream-tools.json` is Google's nine tools, modelled from Google's
 * published reference on 2026-10-27 (its `source` says how): the endpoint
 * answers 401 without a token, so no `tools/list` was captured yet.
 *
 * The gateway's declaration of a tool is Google's, with these changes:
 *   - `list_calendars` takes nothing: the gateway answers it from the
 *     mission's calendars (Google's lists the whole account);
 *   - `calendarId` names a calendar of the mission (its ref or its id) and is
 *     rewritten to the id by the executor;
 *   - the deprecated arguments and the paging of `list_calendars` are not
 *     declared (`WITHHELD_ARGUMENTS`), so never sent;
 *   - a note appended to Google's description where the gateway differs.
 *
 * The module refuses to load when the upstream file lists a tool that is not
 * modelled (`LOCATOR`, `ANSWERED_BY_THE_GATEWAY`) — a new Google tool is
 * neither listed nor callable until it is — or gives an offered tool an
 * argument whose name looks like it locates something (`…Id`, `…Url`,
 * `…Email(s)`, `attendees`) that the model does not know.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import {
  ANSWERED_BY_THE_GATEWAY,
  CALENDAR_ARGUMENT,
  CALENDAR_NOTE,
  DESCRIPTION_NOTES,
  LOCATOR,
  PROVIDER_ID,
  TOOL,
  TOOL_PREFIX,
  UPSTREAM_TOOL,
  WITHHELD_ARGUMENTS,
} from './identity.ts';
import upstream from './upstream-tools.json' with { type: 'json' };

/** One tool as `tools/list` declares it, reduced to what the gateway reads. */
export interface UpstreamTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly required?: readonly string[];
  };
}

/** Where the upstream list comes from; `capturedAt` is `null` while it is modelled from the reference. */
export interface UpstreamToolList {
  readonly source: string;
  readonly capturedAt: string | null;
  readonly tools: readonly UpstreamTool[];
}

function isUpstreamTool(x: unknown): x is UpstreamTool {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  const schema = t.inputSchema as Record<string, unknown> | null | undefined;
  return (
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    typeof schema === 'object' &&
    schema !== null &&
    schema.type === 'object' &&
    typeof schema.properties === 'object' &&
    schema.properties !== null &&
    Object.values(schema.properties).every((p) => typeof p === 'object' && p !== null) &&
    (schema.required === undefined ||
      (Array.isArray(schema.required) && schema.required.every((r) => typeof r === 'string')))
  );
}

/** The upstream file, checked. */
export function readUpstreamToolList(raw: unknown): UpstreamToolList {
  const file = raw as Record<string, unknown> | null;
  if (
    typeof file !== 'object' ||
    file === null ||
    typeof file.source !== 'string' ||
    !(file.captured_at === null || typeof file.captured_at === 'string') ||
    !Array.isArray(file.tools) ||
    !file.tools.every(isUpstreamTool)
  ) {
    throw new Error(`${PROVIDER_ID}: upstream-tools.json is not a list of MCP tool declarations`);
  }
  return { source: file.source, capturedAt: file.captured_at, tools: file.tools };
}

/** A name that may locate something: an id, a URL, an address, people. */
const LOOKS_LOCATING = /(Id|Ids|Url|Urls|Email|Emails)$|attendee/i;

/**
 * The arguments whose name looks locating that the classifier reads itself
 * (`call.ts`), or that point at nothing of the mission: the color of an
 * event, a Meet link, an attachment link to remove.
 */
export const MODELLED_LOCATING_ARGUMENTS: ReadonlySet<string> = new Set([
  'calendarId',
  'eventId',
  'attendees',
  'addedAttendees',
  'removedAttendeeEmails',
  'attendeeEmails',
  'colorId',
  'googleMeetUrl',
  'addGoogleMeetUrl',
  'removedAttachmentFileUrls',
]);

/** Whether the gateway offers an argument of an upstream tool: not withheld. */
export function isOfferedArgument(upstreamName: string, name: string): boolean {
  if (ANSWERED_BY_THE_GATEWAY.has(upstreamName)) return false;
  return WITHHELD_ARGUMENTS[upstreamName]?.[name] === undefined;
}

/** The offered arguments of a tool that look locating and that the model does not know. */
export function unmodelledLocators(tool: UpstreamTool): string[] {
  return Object.keys(tool.inputSchema.properties).filter(
    (name) =>
      isOfferedArgument(tool.name, name) &&
      LOOKS_LOCATING.test(name) &&
      !MODELLED_LOCATING_ARGUMENTS.has(name),
  );
}

const CALENDAR_PROPERTY = {
  type: 'string',
  description:
    'A calendar of this mission: its ref (alice~acme.com) or its id (alice@acme.com). Omitted: the primary calendar.',
} as const;

function gatewaySchema(tool: UpstreamTool): McpToolDeclaration['inputSchema'] {
  const properties: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    if (!isOfferedArgument(tool.name, name)) continue;
    properties[name] = name === CALENDAR_ARGUMENT ? CALENDAR_PROPERTY : { ...schema };
  }
  const required = (tool.inputSchema.required ?? []).filter((name) => {
    if (!isOfferedArgument(tool.name, name)) return false;
    if (!(name in properties)) {
      throw new Error(
        `${PROVIDER_ID}: upstream tool '${tool.name}' requires '${name}', not declared`,
      );
    }
    return true;
  });
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function descriptionOf(tool: UpstreamTool): string {
  if (ANSWERED_BY_THE_GATEWAY.has(tool.name)) {
    return 'List the Google calendars of this mission: for each, its ref (what calendarId of the other tools takes), its id, its name and whether it is the primary calendar. Answered by the gateway, without a call to Google.';
  }
  const notes = [
    ...(CALENDAR_ARGUMENT in tool.inputSchema.properties ? [CALENDAR_NOTE] : []),
    ...(DESCRIPTION_NOTES[tool.name] === undefined ? [] : [DESCRIPTION_NOTES[tool.name]]),
  ];
  return notes.length === 0 ? tool.description : `${tool.description}\n\n${notes.join(' ')}`;
}

/** The declarations the gateway offers, built from the upstream list (refused when it is not modelled). */
export function declarationsOf(list: UpstreamToolList): {
  readonly offered: readonly McpToolDeclaration[];
  readonly upstreamOf: ReadonlyMap<string, UpstreamTool>;
} {
  const byName = new Map(list.tools.map((tool) => [tool.name, tool] as const));
  for (const tool of list.tools) {
    const locator = LOCATOR[tool.name];
    if (locator === undefined && !ANSWERED_BY_THE_GATEWAY.has(tool.name)) {
      throw new Error(`${PROVIDER_ID}: upstream tool '${tool.name}' is not modelled`);
    }
    const unknown = unmodelledLocators(tool);
    if (unknown.length > 0) {
      throw new Error(
        `${PROVIDER_ID}: upstream tool '${tool.name}' takes ${unknown.join(', ')}, which may name something outside the mission: model it first`,
      );
    }
    if (locator === 'calendar' && !(CALENDAR_ARGUMENT in tool.inputSchema.properties)) {
      throw new Error(
        `${PROVIDER_ID}: upstream tool '${tool.name}' has no '${CALENDAR_ARGUMENT}' argument: model its locator first`,
      );
    }
  }
  const offered: McpToolDeclaration[] = [];
  const upstreamOf = new Map<string, UpstreamTool>();
  for (const name of Object.values(TOOL)) {
    const upstreamName = name.slice(TOOL_PREFIX.length);
    const tool = byName.get(upstreamName);
    if (!tool)
      throw new Error(`${PROVIDER_ID}: upstream tool '${upstreamName}' is missing from the list`);
    offered.push({ name, description: descriptionOf(tool), inputSchema: gatewaySchema(tool) });
    upstreamOf.set(name, tool);
  }
  return { offered, upstreamOf };
}

export const UPSTREAM_TOOL_LIST: UpstreamToolList = readUpstreamToolList(upstream);

const declared = declarationsOf(UPSTREAM_TOOL_LIST);

/** Every tool the plugin declares. */
export const googleCalendarTools: readonly McpToolDeclaration[] = declared.offered;

/** The upstream declaration behind a gateway tool name, or `undefined`. */
export function upstreamToolOf(name: string): UpstreamTool | undefined {
  return declared.upstreamOf.get(name);
}

export { UPSTREAM_TOOL };
