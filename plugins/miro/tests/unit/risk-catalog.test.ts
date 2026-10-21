/**
 * Which risks each `miro` tool touches, and what the presets hold : the
 * layering (a deletion and a bulk creation need `content-write` too), an
 * update of the canvas touching both deletion risks, the gates of the
 * facilitator preset.
 */
import { describe, expect, test } from 'vitest';

// Test-only : which risks a slice touches. A plugin's sources import the SDK alone.
import { risksTouchedBy } from '@vaubaan/policy-engine';

import { classifyMiro } from '../../src/classify.ts';
import { TOOL } from '../../src/identity.ts';
import { miroCatalog } from '../../src/index.ts';
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
});

describe('the catalog keeps the ids of catalog 1', () => {
  test('no risk of catalog 1 was renamed or removed', () => {
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
    expect(miroCatalog.catalog.catalog_version).toBe(2);
  });
});

describe('presets', () => {
  const presets = miroCatalog.catalog.presets ?? [];
  const preset = (id: string) => {
    const found = presets.find((p) => p.id === id);
    if (!found) throw new Error(`no preset ${id}`);
    return found;
  };

  test('read-only, scribe, facilitator', () => {
    expect(presets.map((p) => p.id)).toEqual(['read-only', 'scribe', 'facilitator']);
    expect(preset('read-only').entries.map((e) => e.risk_id)).toEqual([
      'miro.read-boards',
      'miro.read-board-content',
      'miro.read-format-guide',
    ]);
  });

  test('scribe never deletes, so it cannot update the canvas', () => {
    const ids = preset('scribe').entries.map((e) => e.risk_id);
    expect(ids).not.toContain('miro.item-delete');
    expect(ids).not.toContain('miro.frame-delete');
    expect(ids).not.toContain('miro.board-create');
    expect(ids).toContain('miro.bulk-create');
  });

  test('facilitator asks first for every deletion and every new board, runs everything else freely', () => {
    const asks = new Set(['miro.item-delete', 'miro.frame-delete', 'miro.board-create']);
    for (const entry of preset('facilitator').entries) {
      expect(entry.gate, entry.risk_id).toBe(asks.has(entry.risk_id) ? 'approval' : 'auto');
    }
    expect(preset('facilitator').entries).toHaveLength(8);
  });

  test('every named risk has a per-minute ceiling', () => {
    for (const risk of miroCatalog.catalog.risks) {
      if (risk.fallback) continue;
      expect(risk.infra_limits?.calls_per_minute_max, risk.id).toBeGreaterThan(0);
    }
  });
});
