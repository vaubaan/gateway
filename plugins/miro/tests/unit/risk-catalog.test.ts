/**
 * Which risks each `miro` tool touches, and what the presets hold : the
 * layering (a deletion and a bulk call need `content-write` too), the gates
 * of the daily-work preset, the ceilings that keep one mission under Miro's
 * credits.
 */
import { describe, expect, test } from 'vitest';

// Test-only : which risks a slice touches. A plugin's sources import the SDK alone.
import { risksTouchedBy } from '@vaubaan/policy-engine';

import { MAX_LISTED_BOARDS } from '../../src/call.ts';
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
    for (const tool of [TOOL.listBoards, TOOL.getBoard]) {
      expect(risksOf(tool), tool).toEqual(['miro.read-boards']);
    }
    for (const tool of [
      TOOL.listItems,
      TOOL.getItem,
      TOOL.listConnectors,
      TOOL.getConnector,
      TOOL.listTags,
      TOOL.listItemTags,
    ]) {
      expect(risksOf(tool), tool).toEqual(['miro.read-board-content']);
    }
  });

  test('creating and editing touch content-write alone', () => {
    for (const tool of [
      TOOL.createStickyNote,
      TOOL.updateStickyNote,
      TOOL.createShape,
      TOOL.updateShape,
      TOOL.createText,
      TOOL.updateText,
      TOOL.createCard,
      TOOL.updateCard,
      TOOL.createFrame,
      TOOL.updateFrame,
      TOOL.createConnector,
      TOOL.updateConnector,
      TOOL.createTag,
      TOOL.attachTag,
      TOOL.removeTag,
    ]) {
      expect(risksOf(tool), tool).toEqual(['miro.content-write']);
    }
  });

  test('a deletion touches content-write and its delete risk', () => {
    for (const tool of [
      TOOL.deleteStickyNote,
      TOOL.deleteShape,
      TOOL.deleteText,
      TOOL.deleteCard,
      TOOL.deleteConnector,
    ]) {
      expect(risksOf(tool), tool).toEqual(['miro.content-write', 'miro.item-delete']);
    }
    expect(risksOf(TOOL.deleteFrame)).toEqual(['miro.content-write', 'miro.frame-delete']);
  });

  test('the bulk call touches content-write and bulk-create', () => {
    expect(risksOf(TOOL.createItems)).toEqual(['miro.bulk-create', 'miro.content-write']);
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
    ]);
  });

  test('scribe never deletes', () => {
    const ids = preset('scribe').entries.map((e) => e.risk_id);
    expect(ids).not.toContain('miro.item-delete');
    expect(ids).not.toContain('miro.frame-delete');
    expect(ids).toContain('miro.bulk-create');
  });

  test('facilitator asks first for every deletion, runs everything else freely', () => {
    for (const entry of preset('facilitator').entries) {
      const deletes = entry.risk_id === 'miro.item-delete' || entry.risk_id === 'miro.frame-delete';
      expect(entry.gate, entry.risk_id).toBe(deletes ? 'approval' : 'auto');
    }
    expect(preset('facilitator').entries).toHaveLength(6);
  });

  test("one mission at every ceiling stays under Miro's 100,000 credits a minute", () => {
    // Worst-case credits per call (handbook §3, "Rate limits") : one list_boards is
    // one unit of read-boards and pays one Level 1 read per mission board.
    const credits: Record<string, number> = {
      'miro.read-boards': 50 * MAX_LISTED_BOARDS,
      'miro.read-board-content': 100,
      'miro.content-write': 150,
      'miro.bulk-create': 2000,
      'miro.item-delete': 550,
      'miro.frame-delete': 550,
    };
    let total = 0;
    for (const risk of miroCatalog.catalog.risks) {
      if (risk.fallback) continue;
      const ceiling = risk.infra_limits?.calls_per_minute_max;
      expect(ceiling, risk.id).toBeDefined();
      total += (ceiling ?? 0) * (credits[risk.id] ?? Number.NaN);
    }
    expect(total).toBeLessThan(100_000);
  });
});
