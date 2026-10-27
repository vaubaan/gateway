/**
 * Mandatory suite of the `google-calendar` plugin: the SDK kit (definition,
 * presets, no wildcard, catalog coverage, identifier proof), the identity,
 * the version, the catalog path, the credential, the tool surface built from
 * the upstream list and its schema check. No network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { catalogPathNextTo, toolPrefixFor } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
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
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(googleCalendarPlugin);
    assertPresetsValid(googleCalendarPlugin);
    assertNoWildcard(googleCalendarPlugin);
  });

  test('every tool classifies to slices the catalog covers, none to the fallback', () => {
    const report = assertCatalogCoverage(googleCalendarPlugin, SAMPLES, {
      resources: [primary, team],
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

  test('the plugin is the default export, and its version is the package version', () => {
    expect(defaultExport).toBe(googleCalendarPlugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({
      name: '@vaubaan/plugin-google-calendar',
      version: googleCalendarPlugin.version,
    });
  });

  test('two presets, read-only first; the fallback in none; deleting and inviting outside ask first', () => {
    const presets = googleCalendarCatalog.catalog.presets ?? [];
    expect(presets.map((p) => p.id)).toEqual(['read-only', 'assistant']);
    const assistant = presets.find((p) => p.id === 'assistant');
    const gate = (id: string) => assistant?.entries.find((e) => e.risk_id === id)?.gate;
    expect(gate('google-calendar.event-delete')).toBe('approval');
    expect(gate('google-calendar.invite-external')).toBe('approval');
    expect(gate('google-calendar.event-create')).toBe('auto');
    for (const preset of presets) {
      expect(preset.entries.map((e) => e.risk_id)).not.toContain(
        'google-calendar.uncategorized-write',
      );
    }
  });
});

describe('google-calendar credential — a client of the OAuth broker', () => {
  test('brokered at "google", the four narrow scopes, never the full calendar scope', () => {
    expect(googleCalendarPlugin.credential).toEqual({
      kind: 'oauth2',
      broker: { provider: 'google' },
      scopes: [SCOPES.calendarListRead, SCOPES.eventsRead, SCOPES.freeBusy, SCOPES.events],
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
