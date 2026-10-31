/**
 * Which risks each `miro` tool touches, and what the macro-actions hold at a
 * trust level : the layering (a deletion and a bulk creation need
 * `content-write` too), an update of the canvas touching both deletion risks,
 * the gates of every macro-action at Trusting.
 */
import { describe, expect, test } from 'vitest';

// Test-only : which risks a slice touches. A plugin's sources import the SDK alone.
import { risksTouchedBy } from '@vaubaan/policy-engine';

import { classifyMiro } from '../../src/classify.ts';
import { TOOL } from '../../src/identity.ts';
import { policyFromMacroActions } from '@vaubaan/plugin-sdk/testing';

import { miroCatalog, miroPlugin } from '../../src/index.ts';
import { SAMPLES, workshop } from './fixtures.ts';

function risksOf(tool: string): string[] {
  const [sample] = SAMPLES[tool] ?? [];
  if (!sample) throw new Error(`no sample for ${tool}`);
  const out = classifyMiro(tool, sample.args, sample.resources ?? [workshop]);
  if ('denied' in out) throw new Error(out.denied);
  const touched = new Set<string>();
  for (const slice of out.slices) {
    for (const risk of risksTouchedBy(slice, miroCatalog.indexed)) touched.add(risk);
  }
  return [...touched].sort();
}

describe('risks touched, tool by tool', () => {
  test('reads', () => {
    expect(risksOf(TOOL.listBoards)).toEqual(['miro.read-boards']);
    for (const tool of [
      TOOL.canvasSearch,
      TOOL.canvasReadAsSvg,
      TOOL.commentListComments,
      TOOL.imageGetData,
      TOOL.imageGetUrl,
      TOOL.prototypeRead,
      TOOL.tableListRows,
      TOOL.tableUpdateHistory,
    ]) {
      expect(risksOf(tool), tool).toEqual(['miro.read-board-content']);
    }
    for (const tool of [TOOL.canvasComposerSkill, TOOL.canvasFormatSkill]) {
      expect(risksOf(tool), tool).toEqual(['miro.read-format-guide']);
    }
  });

  test('single writes touch content-write alone', () => {
    for (const tool of [
      TOOL.imageCreate,
      TOOL.tableCreate,
      TOOL.tableSyncRows,
      TOOL.tableUpdateView,
      TOOL.commentCreate,
      TOOL.commentReply,
      TOOL.commentResolve,
    ]) {
      expect(risksOf(tool), tool).toEqual(['miro.content-write']);
    }
  });

  test('creating many items touches content-write and bulk-create', () => {
    for (const tool of [TOOL.canvasCreateFromSvg, TOOL.prototypeCreate]) {
      expect(risksOf(tool), tool).toEqual(['miro.bulk-create', 'miro.content-write']);
    }
  });

  test('an update of the canvas touches content-write and both deletion risks', () => {
    expect(risksOf(TOOL.canvasUpdateFromSvg)).toEqual([
      'miro.content-write',
      'miro.frame-delete',
      'miro.item-delete',
    ]);
  });

  test('a new board touches board-create alone', () => {
    expect(risksOf(TOOL.boardCreate)).toEqual(['miro.board-create']);
  });

  test("the board's own details, its access and its walkthroughs have risks of their own", () => {
    expect(risksOf(TOOL.boardGetSpace)).toEqual(['miro.read-board-details']);
    expect(risksOf(TOOL.boardUpdateMetadata)).toEqual(['miro.board-details-write']);
    expect(risksOf(TOOL.contentItemListRoles)).toEqual(['miro.read-board-access']);
    expect(risksOf(TOOL.boardShare)).toEqual(['miro.board-share']);
    expect(risksOf(TOOL.boardRoleUpdate)).toEqual(['miro.board-share']);
    expect(risksOf(TOOL.createBoardcast)).toEqual(['miro.boardcast-create']);
  });
});

describe('the catalog keeps the ids of catalogs 1 and 2', () => {
  test('no risk of catalog 1 or 2 was renamed or removed', () => {
    const ids = miroCatalog.catalog.risks.map((r) => r.id);
    for (const id of [
      'miro.read-boards',
      'miro.read-board-content',
      'miro.content-write',
      'miro.bulk-create',
      'miro.item-delete',
      'miro.frame-delete',
      'miro.uncategorized-write',
    ]) {
      expect(ids).toContain(id);
    }
    for (const id of ['miro.read-format-guide', 'miro.board-create']) {
      expect(ids, 'catalog 2').toContain(id);
    }
    expect(miroCatalog.catalog.catalog_version).toBe(5);
  });
});

describe('macro-actions', () => {
  const actions = miroCatalog.catalog.macro_actions;
  const idsOf = (id: string) => actions.find((a) => a.id === id)!.entries.map((e) => e.risk_id);
  const gates = (trustLevels: Parameters<typeof policyFromMacroActions>[1]) =>
    Object.fromEntries(
      policyFromMacroActions(miroPlugin, trustLevels).map((l) => [l.risk_id, l.gate]),
    );

  test('look, draw, rework, manage ; looking at Careful asks first for content and access', () => {
    expect(actions.map((a) => a.id)).toEqual(['look', 'draw', 'rework', 'manage']);
    expect(gates({ look: 'careful' })).toEqual({
      'miro.read-boards': 'auto',
      'miro.read-board-content': 'approval',
      'miro.read-format-guide': 'auto',
      'miro.read-board-details': 'auto',
      'miro.read-board-access': 'approval',
    });
  });

  test('sharing a board is in manage alone : left out at Careful, asked first above', () => {
    for (const action of actions) {
      expect(idsOf(action.id).includes('miro.board-share'), action.id).toBe(action.id === 'manage');
    }
    expect(Object.keys(gates({ manage: 'careful' }))).not.toContain('miro.board-share');
    for (const trustLevel of ['trusting', 'autonomous'] as const) {
      expect(gates({ manage: trustLevel })['miro.board-share']).toBe('approval');
    }
  });

  test('draw never deletes, so it alone cannot update the canvas', () => {
    const ids = idsOf('draw');
    expect(ids).not.toContain('miro.item-delete');
    expect(ids).not.toContain('miro.frame-delete');
    expect(ids).not.toContain('miro.board-create');
    expect(ids).toContain('miro.bulk-create');
    expect(idsOf('rework')).toEqual(['miro.item-delete', 'miro.frame-delete']);
  });

  test('everything at Trusting asks first for deletions, new boards, shares and bulk or recorded content, runs the rest freely', () => {
    const asks = new Set([
      'miro.bulk-create',
      'miro.boardcast-create',
      'miro.item-delete',
      'miro.frame-delete',
      'miro.board-create',
      'miro.board-share',
    ]);
    const all = gates({
      look: 'trusting',
      draw: 'trusting',
      rework: 'trusting',
      manage: 'trusting',
    });
    for (const [riskId, gate] of Object.entries(all)) {
      expect(gate, riskId).toBe(asks.has(riskId) ? 'approval' : 'auto');
    }
    expect(Object.keys(all)).toHaveLength(13);
  });

  test('every named risk has a per-minute ceiling', () => {
    for (const risk of miroCatalog.catalog.risks) {
      if (risk.fallback) continue;
      expect(risk.infra_limits?.calls_per_minute_max, risk.id).toBeGreaterThan(0);
    }
  });
});
