/**
 * Shared fixtures of the `google-calendar` tests: two calendars (the primary
 * one of a Workspace account and a team calendar), an execution context with
 * a brokered access token, a mock of Google's Calendar MCP server, and one
 * realistic sample per tool (the coverage kit and the identifier proof both
 * run on them). Ids follow the shapes of Google's documentation.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { CALENDAR_MCP_URL, PROVIDER_ID, TOOL } from '../../src/identity.ts';

export const PRIMARY_ID = 'alice@acme.example';
export const PRIMARY = 'alice~acme.example';
export const TEAM_ID = 'c_0123abcd@group.calendar.google.com';
export const TEAM = 'c_0123abcd~group.calendar.google.com';
export const OTHER = 'bob~acme.example';
export const EVENT = '7kd8h3j2l1m0n9b8v7c6x5z4a3';

const zoning = { account_email: PRIMARY_ID, internal_domains: ['acme.example'] };

export const primary: Resource = {
  provider: PROVIDER_ID,
  ref: PRIMARY,
  displayName: 'Alice',
  metadata: { primary: true, access_role: 'owner', ...zoning },
};
export const team: Resource = {
  provider: PROVIDER_ID,
  ref: TEAM,
  displayName: 'Team',
  metadata: { primary: false, access_role: 'writer', ...zoning },
};

export const TOKEN = 'ya29.brokered-access-token-1234567890';

export function context(
  fetch: MockFetch | typeof globalThis.fetch,
  resources: readonly Resource[] = [primary, team],
): ExecuteContext {
  return {
    credential: {
      kind: 'oauth2',
      accessToken: TOKEN,
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      metadata: {},
    },
    fetch,
    resources,
  };
}

/** The JSON-RPC request a recorded call carried. */
export function rpcOf(call: RecordedCall): {
  readonly id?: number;
  readonly method: string;
  readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> };
} {
  return call.json as ReturnType<typeof rpcOf>;
}

/** A route of Google's MCP server answering every request with `result`. */
export function mcpRoute(
  result: (call: RecordedCall) => unknown,
  options: { readonly times?: number } = {},
): MockRoute {
  return {
    method: 'POST',
    url: CALENDAR_MCP_URL,
    ...(options.times !== undefined ? { times: options.times } : {}),
    respond: (call) => ({ jsonrpc: '2.0', id: rpcOf(call).id ?? null, result: result(call) }),
  };
}

export function textResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

const at = { startTime: '2026-11-03T10:00:00Z', endTime: '2026-11-03T11:00:00Z' };

/** One table for the catalog coverage and the identifier proof. */
export const SAMPLES: ToolSamples = {
  [TOOL.listCalendars]: [{ args: {} }],
  [TOOL.listEvents]: [
    { args: { calendarId: TEAM, ...at, orderBy: 'startTime', pageSize: 10 } },
    { args: { calendarId: OTHER }, expectDenied: true },
  ],
  [TOOL.searchEvents]: [{ args: { query: 'quarterly review' } }],
  [TOOL.getEvent]: [{ args: { calendarId: PRIMARY_ID, eventId: EVENT } }],
  [TOOL.suggestTime]: [
    { args: { attendeeEmails: ['bob@acme.example'], ...at, durationMinutes: 30 } },
  ],
  [TOOL.createEvent]: [
    { args: { summary: 'Focus', ...at } },
    {
      args: {
        summary: 'Sync',
        ...at,
        attendees: [{ email: 'bob@acme.example' }, { email: 'carol@customer.example' }],
      },
    },
  ],
  [TOOL.updateEvent]: [
    { args: { eventId: EVENT, summary: 'Sync (moved)', ...at } },
    { args: { eventId: EVENT, calendarId: TEAM, location: 'Room 2', notificationLevel: 'NONE' } },
  ],
  [TOOL.deleteEvent]: [{ args: { eventId: EVENT, notificationLevel: 'NONE' } }],
  [TOOL.respondToEvent]: [{ args: { eventId: EVENT, responseStatus: 'accepted' } }],
};
