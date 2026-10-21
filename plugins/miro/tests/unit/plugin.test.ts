/**
 * Mandatory suite of the `miro` plugin : the SDK kit (definition, presets,
 * no wildcard, catalog coverage, identifier proof), the identity, the
 * version, the catalog path, the credential, the tool surface built from
 * the upstream list. No network.
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

import {
  BOARD_LOCATOR,
  LEFT_OUT_UPSTREAM_TOOLS,
  LOCATOR,
  MIRO_OAUTH,
  PROVIDER_ID,
  TOOL,
  UPSTREAM_TOOL,
} from '../../src/identity.ts';
import defaultExport, { miroCatalog, miroPlugin } from '../../src/index.ts';
import {
  UPSTREAM_TOOL_LIST,
  declarationsOf,
  readUpstreamToolList,
  type UpstreamTool,
} from '../../src/tools.ts';
import { SAMPLES, context, mcpRoute, textResult, workshop } from './fixtures.ts';

describe('miro plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(miroPlugin);
    assertPresetsValid(miroPlugin);
    assertNoWildcard(miroPlugin);
  });

  test('every tool classifies to slices the catalog covers, none to the fallback', () => {
    const report = assertCatalogCoverage(miroPlugin, SAMPLES, { resources: [workshop] });
    const named = miroCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect(report.risksTouched).toEqual(named);
    expect(report.risksTouched).toHaveLength(8);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or never reach a URL', async () => {
    const report = await assertIdentifiersRefused(miroPlugin, SAMPLES, {
      resources: [workshop],
      context: (fetch, resources) => context(fetch, resources),
      routes: [mcpRoute(() => textResult('ok'))],
      pathIdentifiers: {
        none: "every call is a JSON-RPC body to the one URL of Miro's MCP server; the board URL inside it is written by the gateway from the classified ref (identifiers.test.ts)",
      },
    });
    expect(report.toolsChecked).toBe(miroPlugin.tools.length);
    expect(report.pathIdentifiers).toEqual([]);
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(miroCatalog.catalog.provider).toBe(PROVIDER_ID);
    expect(miroCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the provider id, once, and every tool has a title', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    expect(miroPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(miroPlugin.tools).toHaveLength(22);
    expect(Object.values(TOOL).every((name) => name.startsWith(prefix))).toBe(true);
    expect(Object.keys(miroPlugin.toolTitles ?? {}).sort()).toEqual(Object.values(TOOL).sort());
    expect(miroPlugin.resourceCreatingTools).toEqual([TOOL.boardCreate]);
  });

  test('the plugin is the default export, and its version is the package version', () => {
    expect(defaultExport).toBe(miroPlugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ name: '@vaubaan/plugin-miro', version: miroPlugin.version });
  });

  test('no environment anywhere : no envScopable entity, no env-scoped risk', () => {
    const entities = miroPlugin.dataModel.planes.flatMap((p) => p.entities);
    expect(entities.some((e) => e.envScopable === true)).toBe(false);
    for (const risk of miroCatalog.catalog.risks) {
      expect(risk.acceptable_in_envs, risk.id).toBeUndefined();
    }
  });
});

describe('miro credential — OAuth with a client the gateway registers itself', () => {
  test("Miro's MCP authorization server, PKCE, the MCP server as audience, two scopes", () => {
    expect(miroPlugin.credential).toEqual({
      kind: 'oauth2',
      authorizationUrl: MIRO_OAUTH.authorizationUrl,
      tokenUrl: MIRO_OAUTH.tokenUrl,
      clientRegistration: { registrationUrl: 'https://mcp.miro.com/register' },
      scopes: ['boards:read', 'boards:write'],
      pkce: true,
      resourceIndicator: 'https://mcp.miro.com/',
      clientAuthMethod: 'client_secret_post',
      refreshable: true,
    });
  });

  test('nothing to declare : no app setting, and no revocation endpoint (Miro publishes none)', () => {
    const spec = miroPlugin.credential;
    if (spec.kind !== 'oauth2') throw new Error('expected oauth2');
    expect(spec.appConfigFields).toBeUndefined();
    expect(spec.revocation).toBeUndefined();
    expect(miroPlugin.manualRevocation).toMatch(/Vaubaan Gateway/);
  });
});

describe('miro tools — built from the upstream list', () => {
  test('the list is modelled, not captured, and says so', () => {
    expect(UPSTREAM_TOOL_LIST.capturedAt).toBeNull();
    expect(UPSTREAM_TOOL_LIST.source).toMatch(/modelled/);
  });

  test('every upstream tool is offered or left out with a reason, never both', () => {
    for (const tool of UPSTREAM_TOOL_LIST.tools) {
      const offered = LOCATOR[tool.name] !== undefined;
      const leftOut = LEFT_OUT_UPSTREAM_TOOLS[tool.name] !== undefined;
      expect(offered !== leftOut, tool.name).toBe(true);
    }
    expect(Object.keys(LEFT_OUT_UPSTREAM_TOOLS).sort()).toEqual(
      [
        UPSTREAM_TOOL.boardSearchBoards,
        UPSTREAM_TOOL.imageGetUploadUrl,
        UPSTREAM_TOOL.userWhoAmI,
      ].sort(),
    );
  });

  test("the gateway's schema takes board and item_id, never miro_url", () => {
    for (const tool of miroPlugin.tools) {
      const properties = tool.inputSchema.properties ?? {};
      expect(Object.keys(properties), tool.name).not.toContain(BOARD_LOCATOR);
    }
    const read = miroPlugin.tools.find((t) => t.name === TOOL.imageGetData);
    expect(read?.inputSchema.required).toEqual(['board', 'item_id']);
    const create = miroPlugin.tools.find((t) => t.name === TOOL.boardCreate);
    expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual(['name', 'description']);
  });

  const base: UpstreamTool = {
    name: UPSTREAM_TOOL.canvasSearch,
    description: 'Search.',
    inputSchema: {
      type: 'object',
      properties: { miro_url: { type: 'string' }, query: { type: 'string' } },
      required: ['miro_url'],
    },
  };
  const listWith = (tools: readonly UpstreamTool[]) =>
    readUpstreamToolList({
      source: 'test',
      captured_at: null,
      tools: UPSTREAM_TOOL_LIST.tools.map((t) => tools.find((x) => x.name === t.name) ?? t),
    });

  test('a tool Miro adds is refused until it is modelled', () => {
    const list = readUpstreamToolList({
      source: 'test',
      captured_at: '2026-10-21',
      tools: [...UPSTREAM_TOOL_LIST.tools, { ...base, name: 'board_delete' }],
    });
    expect(() => declarationsOf(list)).toThrow(/'board_delete' is not modelled/);
  });

  test('an argument that may name another board is refused until it is modelled', () => {
    for (const name of ['target_board', 'parent_url', 'board_id', 'frame_ids']) {
      const tool: UpstreamTool = {
        ...base,
        inputSchema: {
          ...base.inputSchema,
          properties: { ...base.inputSchema.properties, [name]: { type: 'string' } },
        },
      };
      expect(() => declarationsOf(listWith([tool])), name).toThrow(/may name another board/);
    }
  });

  test('a board tool without the locator is refused until its locator is modelled', () => {
    const tool: UpstreamTool = {
      ...base,
      inputSchema: { type: 'object', properties: { board_url: { type: 'string' } } },
    };
    expect(() => declarationsOf(listWith([tool]))).toThrow(/may name another board/);
    const bare: UpstreamTool = { ...base, inputSchema: { type: 'object', properties: {} } };
    expect(() => declarationsOf(listWith([bare]))).toThrow(/has no 'miro_url' argument/);
  });

  test('a file that is not a tool list is refused', () => {
    expect(() => readUpstreamToolList([])).toThrow(/not a list of MCP tool declarations/);
    expect(() =>
      readUpstreamToolList({ source: 'x', captured_at: null, tools: [{ name: 1 }] }),
    ).toThrow();
  });
});
