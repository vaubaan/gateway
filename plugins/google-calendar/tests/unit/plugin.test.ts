/**
 * Mandatory suite of the `google-calendar` plugin: the SDK kit (definition,
 * macro-actions, no wildcard, catalog coverage, identifier proof), the identity,
 * the version, the catalog path, the credential, the tool surface declared
 * in code. No network.
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

import { SERVICE_ID, SCOPES, TOOL } from '../../src/identity.ts';
import defaultExport, { googleCalendarCatalog, googleCalendarPlugin } from '../../src/index.ts';
import { EVENT_GET, SAMPLES, context, primary, team } from './fixtures.ts';

describe('google-calendar plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(googleCalendarPlugin);
    assertNoWildcard(googleCalendarPlugin);
  });

  test('every tool classifies to slices the catalog covers, none to the fallback', () => {
    const report = assertCatalogCoverage(googleCalendarPlugin);
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
      routes: [EVENT_GET],
    });
    expect(report.toolsChecked).toBe(googleCalendarPlugin.tools.length);
    // Found by running the samples: the arguments that are a segment of a request path.
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))].sort()).toEqual([
      'calendarId',
      'eventId',
    ]);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(googleCalendarCatalog.catalog.service).toBe(SERVICE_ID);
    expect(googleCalendarCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${SERVICE_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the service id, once, and every tool has a title', () => {
    const prefix = toolPrefixFor(SERVICE_ID);
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

describe('google-calendar tools — declared in code', () => {
  const props = (name: string) =>
    Object.keys(
      googleCalendarPlugin.tools.find((t) => t.name === name)?.inputSchema.properties ?? {},
    );

  test('every tool but list_calendars and suggest_time names its calendar', () => {
    for (const tool of googleCalendarPlugin.tools) {
      const locates = !([TOOL.listCalendars, TOOL.suggestTime] as string[]).includes(tool.name);
      expect(props(tool.name).includes('calendarId'), tool.name).toBe(locates);
    }
    expect(props(TOOL.listCalendars)).toEqual([]);
  });

  test('the MCP-only and deprecated arguments are gone; sendUpdates replaces notificationLevel', () => {
    const all = googleCalendarPlugin.tools.flatMap((t) => props(t.name));
    for (const gone of [
      'notificationLevel',
      'eventTypeFilter',
      'addedAttendeeEmails',
      'pageSize',
      'fullText',
      'query',
    ]) {
      expect(all, gone).not.toContain(gone);
    }
    expect(props(TOOL.createEvent)).not.toContain('attendeeEmails');
    for (const tool of [
      TOOL.createEvent,
      TOOL.updateEvent,
      TOOL.deleteEvent,
      TOOL.respondToEvent,
    ]) {
      expect(props(tool)).toContain('sendUpdates');
    }
  });

  test('every required argument is declared', () => {
    for (const tool of googleCalendarPlugin.tools) {
      for (const name of tool.inputSchema.required ?? []) expect(props(tool.name)).toContain(name);
    }
  });
});
