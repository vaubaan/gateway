/**
 * Mandatory suite of the `outlook` plugin: the SDK kit (definition,
 * macro-actions, no wildcard, catalog coverage, data model, identifier
 * proof), the identity, the catalog path, the credential, the tool surface.
 * No network.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { catalogPathIssues, catalogPathNextTo, toolPrefixFor } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  policyFromMacroActions,
} from '@vaubaan/plugin-sdk/testing';

import { PROVIDER_ID, SCOPES, TOOL } from '../../src/identity.ts';
import defaultExport, { outlookCatalog, outlookPlugin } from '../../src/index.ts';
import { READ_FIRST, SAMPLES, context, mailbox } from './fixtures.ts';

describe('outlook plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(outlookPlugin);
    assertNoWildcard(outlookPlugin);
  });

  test('every tool classifies to slices the catalog covers, none to the fallback', () => {
    const report = assertCatalogCoverage(outlookPlugin);
    const named = outlookCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect([...report.risksTouched].sort()).toEqual([...named].sort());
    expect(report.risksTouched).toHaveLength(27);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('every slice and every pattern is a path of the data model', () => {
    assertSlicesOnDataModel(outlookPlugin, SAMPLES, { resources: [mailbox] });
    expect(catalogPathIssues(outlookPlugin)).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or never reach a URL', async () => {
    const report = await assertIdentifiersRefused(outlookPlugin, SAMPLES, {
      resources: [mailbox],
      context: (fetch, resources) => context(fetch, resources),
      routes: [...READ_FIRST],
    });
    expect(report.toolsChecked).toBe(outlookPlugin.tools.length);
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))].sort()).toEqual([
      'attachment_id',
      'calendar',
      'draft_id',
      'event_id',
      'folder',
      'message_id',
      'parent',
      // A closed enum mapped to Graph's action (accept → /accept, tentative → /tentativelyAccept).
      'response',
    ]);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(outlookCatalog.catalog.provider).toBe(PROVIDER_ID);
    expect(outlookCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the provider id, once, and every tool has a title', () => {
    expect(toolPrefixFor(PROVIDER_ID)).toBe('outlook__');
    expect(outlookPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(outlookPlugin.tools).toHaveLength(23);
    expect(Object.keys(outlookPlugin.toolTitles ?? {}).sort()).toEqual(Object.values(TOOL).sort());
  });

  test('the plugin is the default export', () => {
    expect(defaultExport).toBe(outlookPlugin);
  });

  test('six macro-actions; the fallback in none; at Trusting, external sends and invitations ask first', () => {
    const actions = outlookCatalog.catalog.macro_actions ?? [];
    expect(actions.map((a) => a.id)).toEqual([
      'read',
      'draft',
      'send',
      'tidy',
      'schedule',
      'invite',
    ]);
    expect(actions.flatMap((a) => a.entries.map((e) => e.risk_id))).not.toContain(
      'outlook.uncategorized-write',
    );
    const policy = policyFromMacroActions(outlookPlugin, {
      read: 'trusting',
      draft: 'trusting',
      send: 'trusting',
      tidy: 'trusting',
      schedule: 'trusting',
      invite: 'trusting',
    });
    const gate = (id: string) => policy.find((l) => l.risk_id === id)?.gate;
    expect(gate('outlook.send-to-zone-external')).toBe('approval');
    expect(gate('outlook.invite-external')).toBe('approval');
    expect(gate('outlook.notify-guests')).toBe('approval');
    expect(gate('outlook.draft-write')).toBe('auto');
    expect(gate('outlook.event-create')).toBe('auto');
  });
});

describe('outlook credential — a client of the OAuth broker', () => {
  test('brokered at "microsoft", offline_access and the four delegated Graph permissions', () => {
    expect(outlookPlugin.credential).toEqual({
      kind: 'oauth2',
      broker: { provider: 'microsoft' },
      scopes: [
        'openid',
        'email',
        'profile',
        'offline_access',
        SCOPES.userRead,
        SCOPES.mailReadWrite,
        SCOPES.mailSend,
        SCOPES.calendarsReadWrite,
      ],
    });
  });
});

describe('outlook tools — declared in code', () => {
  const props = (name: string) =>
    Object.keys(outlookPlugin.tools.find((t) => t.name === name)?.inputSchema.properties ?? {});

  test('every tool takes mailbox; every calendar write takes calendar', () => {
    for (const tool of outlookPlugin.tools)
      expect(props(tool.name), tool.name).toContain('mailbox');
    for (const tool of [
      TOOL.createEvent,
      TOOL.updateEvent,
      TOOL.deleteEvent,
      TOOL.respondToEvent,
    ]) {
      expect(props(tool)).toContain('calendar');
    }
  });

  test('every required argument is declared', () => {
    for (const tool of outlookPlugin.tools) {
      for (const name of tool.inputSchema.required ?? []) expect(props(tool.name)).toContain(name);
    }
  });

  test('no tool deletes mail or forwards it', () => {
    const names = outlookPlugin.tools.map((t) => t.name);
    for (const gone of ['delete_message', 'forward', 'reply', 'reply_all']) {
      expect(names).not.toContain(`outlook__${gone}`);
    }
  });
});
