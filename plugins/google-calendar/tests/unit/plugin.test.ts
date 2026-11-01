/**
 * Mandatory suite of the `google-calendar` plugin: the SDK kit (definition,
 * macro-actions, no wildcard, catalog coverage, identifier proof), the identity,
 * the version, the catalog path, the credential, the tool surface built from
 * the upstream list and its schema check. No network.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { catalogPathNextTo, toolPrefixFor } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  policyFromMacroActions,
} from '@vaubaan/plugin-sdk/testing';

import { toolDrift } from '../../src/execute.ts';
import { PROVIDER_ID, SCOPES, TOOL, UPSTREAM_TOOL } from '../../src/identity.ts';
import defaultExport, { googleCalendarCatalog, googleCalendarPlugin } from '../../src/index.ts';
import {
  UPSTREAM_TOOL_LIST,
  declarationsOf,
  readUpstreamToolList,
  type UpstreamTool,
} from '../../src/tools.ts';
import { SAMPLES, context, mcpRoute, primary, team, textResult } from './fixtures.ts';

describe('google-calendar plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(googleCalendarPlugin);
    assertNoWildcard(googleCalendarPlugin);
  });

  test('every tool classifies to slices the catalog covers, none to the fallback', () => {
    const report = assertCatalogCoverage(googleCalendarPlugin, SAMPLES, {
      resources: [primary, team],
    });
    // Paths only : this model's cardinalities count instances, not how a slice names them.
    assertSlicesOnDataModel(googleCalendarPlugin, SAMPLES, {
      resources: [primary, team],
      cardinalities: false,
    });
    const named = googleCalendarCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect([...report.risksTouched].sort()).toEqual([...named].sort());
    expect(report.risksTouched).toHaveLength(10);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or never reach a URL', async () => {
    const report = await assertIdentifiersRefused(googleCalendarPlugin, SAMPLES, {
      resources: [primary, team],
      context: (fetch, resources) => context(fetch, resources),
      routes: [mcpRoute(() => textResult('ok'))],
      pathIdentifiers: {
        none: "every call is a JSON-RPC body to the one URL of Google's Calendar MCP server",
      },
    });
    expect(report.toolsChecked).toBe(googleCalendarPlugin.tools.length);
    expect(report.pathIdentifiers).toEqual([]);
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(googleCalendarCatalog.catalog.provider).toBe(PROVIDER_ID);
    expect(googleCalendarCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the provider id, once, and every tool has a title', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    expect(prefix).toBe('google_calendar__');
    expect(googleCalendarPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(googleCalendarPlugin.tools).toHaveLength(9);
    expect(Object.keys(googleCalendarPlugin.toolTitles ?? {}).sort()).toEqual(
      Object.values(TOOL).sort(),
    );
  });

  test('the plugin is the default export', () => {
    expect(defaultExport).toBe(googleCalendarPlugin);
  });

  test('read, schedule, invite; the fallback in none; at Trusting deleting and inviting outside ask first', () => {
    const actions = googleCalendarCatalog.catalog.macro_actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['read', 'schedule', 'invite']);
    const policy = policyFromMacroActions(googleCalendarPlugin, {
      read: 'trusting',
      schedule: 'trusting',
      invite: 'trusting',
    });
    const gate = (id: string) => policy.find((l) => l.risk_id === id)?.gate;
    expect(gate('google-calendar.event-delete')).toBe('approval');
    expect(gate('google-calendar.invite-external')).toBe('approval');
    expect(gate('google-calendar.event-create')).toBe('auto');
    expect(actions.flatMap((a) => a.entries.map((e) => e.risk_id))).not.toContain(
      'google-calendar.uncategorized-write',
    );
  });
});

describe('google-calendar credential — a client of the OAuth broker', () => {
  test('brokered at "google", the two narrow scopes, never the full calendar scope', () => {
    expect(googleCalendarPlugin.credential).toEqual({
      kind: 'oauth2',
      broker: { provider: 'google' },
      scopes: [SCOPES.calendarListRead, SCOPES.events],
    });
    const spec = googleCalendarPlugin.credential;
    if (spec.kind !== 'oauth2') throw new Error('expected oauth2');
    expect(spec.scopes).not.toContain('https://www.googleapis.com/auth/calendar');
  });
});

describe('google-calendar tools — built from the upstream list', () => {
  test("Google's nine tools, modelled from the reference, with its source and date: no drift against itself", () => {
    expect(UPSTREAM_TOOL_LIST.capturedAt).toBeNull();
    expect(UPSTREAM_TOOL_LIST.source).toMatch(/developers\.google\.com.*2026-10-27/);
    expect(UPSTREAM_TOOL_LIST.tools.map((t) => t.name).sort()).toEqual(
      Object.values(UPSTREAM_TOOL).sort(),
    );
    expect(toolDrift({ tools: UPSTREAM_TOOL_LIST.tools })).toEqual({
      gone: [],
      unmodelled: [],
      arguments: {},
    });
  });

  test('the schema check: a live list that drops a tool, adds one or changes arguments is reported', () => {
    const live = UPSTREAM_TOOL_LIST.tools
      .filter((t) => t.name !== 'suggest_time')
      .map((t) =>
        t.name === 'get_event'
          ? { ...t, inputSchema: { ...t.inputSchema, properties: { eventId: {}, fields: {} } } }
          : t,
      );
    expect(toolDrift({ tools: [...live, { name: 'create_calendar' }] })).toEqual({
      gone: ['suggest_time'],
      unmodelled: ['create_calendar'],
      arguments: { get_event: ['+fields', '-calendarId'] },
    });
  });

  test('the schema check reads an untrusted answer: what is not a named tool is ignored', () => {
    const everyToolGone = UPSTREAM_TOOL_LIST.tools.map((t) => t.name);
    expect(toolDrift(null).gone).toEqual(everyToolGone);
    expect(toolDrift({ tools: 'none' }).gone).toEqual(everyToolGone);
    expect(toolDrift({ tools: [null, 7, { name: 3 }, { name: 'x', inputSchema: 'y' }] })).toEqual({
      gone: everyToolGone,
      unmodelled: ['x'],
      arguments: {},
    });
  });

  test('an upstream tool the model does not know is neither listed nor callable: the module refuses it', () => {
    const extra: UpstreamTool = {
      name: 'delete_calendar',
      description: 'Deletes a calendar.',
      inputSchema: { type: 'object', properties: { calendarId: { type: 'string' } } },
    };
    expect(() =>
      declarationsOf({ ...UPSTREAM_TOOL_LIST, tools: [...UPSTREAM_TOOL_LIST.tools, extra] }),
    ).toThrow(/'delete_calendar' is not modelled/);
  });

  test('an unknown locating argument of an offered tool stops the module until it is modelled', () => {
    const tools = UPSTREAM_TOOL_LIST.tools.map((t) =>
      t.name === 'get_event'
        ? {
            ...t,
            inputSchema: {
              ...t.inputSchema,
              properties: { ...t.inputSchema.properties, organizerEmail: { type: 'string' } },
            },
          }
        : t,
    );
    expect(() => declarationsOf({ ...UPSTREAM_TOOL_LIST, tools })).toThrow(/takes organizerEmail/);
  });

  test('the deprecated arguments and the paging of list_calendars are not offered', () => {
    const props = (name: string) =>
      Object.keys(
        googleCalendarPlugin.tools.find((t) => t.name === name)?.inputSchema.properties ?? {},
      );
    expect(props(TOOL.listCalendars)).toEqual([]);
    expect(props(TOOL.createEvent)).not.toContain('attendeeEmails');
    expect(props(TOOL.updateEvent)).not.toContain('addedAttendeeEmails');
    expect(props(TOOL.listEvents)).not.toContain('eventTypeFilter');
  });

  test('the upstream file is checked', () => {
    expect(() => readUpstreamToolList({ source: 'x', captured_at: null, tools: [{}] })).toThrow(
      /not a list of MCP tool declarations/,
    );
  });
});
