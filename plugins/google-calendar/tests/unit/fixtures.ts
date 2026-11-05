/**
 * Shared fixtures of the `google-calendar` tests: two calendars (the primary
 * one of a Workspace account and a team calendar), an execution context with
 * a brokered access token, routes of Google's Calendar REST API, and the
 * plugin's own samples (`src/examples.ts` ; the coverage kit and the
 * identifier proof both run on them). Ids follow the shapes of Google's documentation.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import {
  EVENT,
  EXAMPLE_PRIMARY as primary,
  EXAMPLE_TEAM as team,
  OTHER,
  PRIMARY,
  PRIMARY_ID,
  TEAM,
  TEAM_ID,
} from '../../src/examples.ts';
import { CALENDAR_API_BASE } from '../../src/identity.ts';
import { googleCalendarPlugin } from '../../src/index.ts';

// The ids and calendars the plugin's `examples` run on (`src/examples.ts`).
export { EVENT, OTHER, PRIMARY, PRIMARY_ID, TEAM, TEAM_ID, primary, team };

export const TOKEN = 'ya29.brokered-access-token-1234567890';

export function context(
  fetch: MockFetch | typeof globalThis.fetch,
  resources: readonly Resource[] = [primary, team],
  scopes: readonly string[] = [],
): ExecuteContext {
  return {
    credential: {
      kind: 'oauth2',
      accessToken: TOKEN,
      refreshToken: null,
      expiresAt: null,
      scopes,
      metadata: {},
    },
    fetch,
    resources,
  };
}

/** The URL of a path of the API, the calendar id percent-encoded as the executor writes it. */
export function api(path: string): string {
  return `${CALENDAR_API_BASE}${path}`;
}

/** The path and the query of a recorded call, the query as an object. */
export function requestOf(call: RecordedCall): {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
} {
  const url = new URL(call.url);
  return {
    method: call.method,
    path: url.pathname.replace('/calendar/v3', ''),
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

/** One event as Google answers it to `maxAttendees=1`, this account's entry marked `self`. */
export const INVITATION = {
  id: EVENT,
  summary: 'Quarterly review',
  attendeesOmitted: true,
  attendees: [{ email: PRIMARY_ID, self: true, responseStatus: 'needsAction' }],
};

/** A GET of one event answers `INVITATION`. */
export const EVENT_GET: MockRoute = {
  method: 'GET',
  url: (url) => /\/events\/[^/?]+(\?|$)/.test(url),
  body: INVITATION,
};

/** One table for the catalog coverage and the identifier proof : the plugin's `examples`. */
export const SAMPLES: ToolSamples = googleCalendarPlugin.examples;
