/**
 * Mandatory suite of the `asana` plugin : the SDK kit (well-formed, no
 * wildcard, catalog coverage, slices on the data model, the identifier
 * proof), the layered deletion, the macro-actions, the identity and the
 * version. No network : `execute` runs against `mockFetch`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  catalogPathIssues,
  catalogPathNextTo,
  parseSlice,
  toolPrefixFor,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  policyFromMacroActions,
  risksTouchedBy,
} from '@vaubaan/plugin-sdk/testing';

import { PAT_FIELD, PROVIDER_ID, TOOL } from '../../src/identity.ts';
import defaultExport, { asanaCatalog, asanaPlugin, classifyAsana } from '../../src/index.ts';
import { PROJECT, TASK, TOKEN, project, world } from './fixtures.ts';
import { SAMPLES } from './samples.ts';

describe('asana plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(asanaPlugin);
    assertNoWildcard(asanaPlugin);
  });

  test('every tool classifies to slices the catalog covers, none by the fallback', () => {
    const report = assertCatalogCoverage(asanaPlugin, SAMPLES, { resources: [project] });
    assertSlicesOnDataModel(asanaPlugin, SAMPLES, { resources: [project] });
    expect(catalogPathIssues(asanaPlugin)).toEqual([]);
    const named = asanaCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect(report.risksTouched).toEqual(named);
    expect(report.risksTouched).toHaveLength(7);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(asanaPlugin, SAMPLES, {
      resources: [project],
      routes: world(),
      context: (fetch, resources) => ({
        credential: { kind: 'api-key', fields: { [PAT_FIELD]: TOKEN }, metadata: {} },
        fetch,
        resources,
      }),
    });
    expect(report.toolsChecked).toBe(asanaPlugin.tools.length);
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getTask, argument: 'task_gid' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getProject, argument: 'project' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.listTasks, argument: 'section' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.createTask, argument: 'parent' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.deleteTask, argument: 'task_gid' });
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(asanaCatalog.catalog.provider).toBe(PROVIDER_ID);
    expect(asanaCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the provider id, once, and each has a title', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    expect(asanaPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(Object.values(TOOL).every((name) => name.startsWith(prefix))).toBe(true);
    expect(Object.keys(asanaPlugin.toolTitles ?? {}).sort()).toEqual(Object.values(TOOL).sort());
    expect(asanaPlugin.credential).toMatchObject({
      kind: 'api-key',
      fields: [{ name: PAT_FIELD, secret: true }],
    });
  });

  test('the plugin is the default export, and its version is the package version', () => {
    expect(defaultExport).toBe(asanaPlugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ version: asanaPlugin.version });
  });
});

describe('asana catalog — layering and macro-actions', () => {
  const touched = (tool: string, args: Record<string, unknown>) => {
    const out = classifyAsana(tool, args, [project]);
    if ('denied' in out) throw new Error(out.denied);
    return [...new Set(out.slices.flatMap((s) => risksTouchedBy(s, asanaCatalog.indexed)))].sort();
  };

  test('a deletion touches task-update and task-delete ; a change touches task-update alone', () => {
    expect(touched(TOOL.deleteTask, { project: PROJECT, task_gid: TASK })).toEqual([
      'asana.task-delete',
      'asana.task-update',
    ]);
    expect(touched(TOOL.updateTask, { project: PROJECT, task_gid: TASK, name: 'n' })).toEqual([
      'asana.task-update',
    ]);
  });

  test('a comment, a creation and the reads each touch their own risk', () => {
    expect(touched(TOOL.addComment, { project: PROJECT, task_gid: TASK, text: 'x' })).toEqual([
      'asana.comment-create',
    ]);
    expect(touched(TOOL.createTask, { project: PROJECT, name: 'n' })).toEqual([
      'asana.task-create',
    ]);
    expect(touched(TOOL.listComments, { project: PROJECT, task_gid: TASK })).toEqual([
      'asana.comment-read',
    ]);
    expect(touched(TOOL.getTask, { project: PROJECT, task_gid: TASK })).toEqual([
      'asana.task-read',
    ]);
    expect(touched(TOOL.listSections, { project: PROJECT })).toEqual(['asana.project-read']);
    expect(touched(TOOL.listProjects, {})).toEqual(['asana.project-read']);
    // The fallback is reachable by pattern only.
    expect(risksTouchedBy(parseSlice('asana.project[1].unknown.W'), asanaCatalog.indexed)).toEqual([
      'asana.uncategorized-write',
    ]);
  });

  test('macro-actions : read, work, clean-up ; the fallback in none', () => {
    const actions = asanaCatalog.catalog.macro_actions;
    expect(actions.map((a) => a.id)).toEqual(['read', 'work', 'clean-up']);
    const ids = actions.flatMap((a) => a.entries.map((e) => e.risk_id));
    expect(ids).not.toContain(`${PROVIDER_ID}.uncategorized-write`);
  });

  test('at Careful, reading comments and changing or deleting tasks ask first', () => {
    const policy = policyFromMacroActions(asanaPlugin, {
      read: 'careful',
      work: 'careful',
      'clean-up': 'careful',
    });
    const gates = Object.fromEntries(policy.map((line) => [line.risk_id, line.gate]));
    expect(gates).toEqual({
      'asana.project-read': 'auto',
      'asana.task-read': 'auto',
      'asana.comment-read': 'approval',
      'asana.task-create': 'auto',
      'asana.task-update': 'approval',
      'asana.comment-create': 'auto',
      'asana.task-delete': 'approval',
    });
  });

  test('at Autonomous everything runs freely', () => {
    const policy = policyFromMacroActions(asanaPlugin, {
      read: 'autonomous',
      work: 'autonomous',
      'clean-up': 'autonomous',
    });
    expect(policy.every((line) => line.gate === 'auto')).toBe(true);
  });
});
