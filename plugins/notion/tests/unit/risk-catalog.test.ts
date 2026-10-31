/**
 * The catalog seen through the matcher : which risks each write touches, no
 * overlap between write patterns, the root trash touching two risks, no
 * environment anywhere.
 */
import { describe, expect, test } from 'vitest';

import { risksTouchedBy } from '@vaubaan/plugin-sdk/testing';

import { parseSlice, type Resource } from '@vaubaan/plugin-sdk';

import { classifyNotion } from '../../src/classify.ts';
import { notionDataModel } from '../../src/data-model.ts';
import { notionCatalog, notionPlugin } from '../../src/index.ts';
import { SAMPLES } from './samples.ts';
import { pageRoot } from './fixtures.ts';

const touched = (tool: string, args: Record<string, unknown>, resources: readonly Resource[]) => {
  const out = classifyNotion(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map((s) => [...risksTouchedBy(s, notionCatalog.indexed)].sort());
};

describe('notion catalog', () => {
  test('every realistic call touches exactly one named risk per slice', () => {
    for (const [tool, samples] of Object.entries(SAMPLES)) {
      for (const sample of samples) {
        if (sample.expectDenied) continue;
        for (const risks of touched(tool, sample.args, sample.resources ?? [pageRoot])) {
          expect(risks, tool).toHaveLength(1);
        }
      }
    }
  });

  test('the write patterns do not overlap', () => {
    const writes = notionCatalog.catalog.risks.filter(
      (r) => !r.fallback && [r.matches].flat().every((m) => m.endsWith('.W')),
    );
    const probe: Record<string, string> = {
      'notion.page-create': 'notion.root[r].page[p].subpage.W',
      'notion.page-update': 'notion.root[r].page[p].properties.W',
      'notion.content-append': 'notion.root[r].block[b].children.W',
      'notion.block-update': 'notion.root[r].block[b].W',
      'notion.block-delete': 'notion.root[r].block[b].delete.W',
      'notion.page-trash': 'notion.root[r].page[p].trash.W',
      'notion.page-restore': 'notion.root[r].page[p].restore.W',
      'notion.root-trash': 'notion.root[r].root-trash.W',
      'notion.entry-create': 'notion.root[r].data-source[s].entry.W',
      'notion.entry-update': 'notion.root[r].data-source[s].entry[e].W',
      'notion.comment-create': 'notion.root[r].block[b].comment.W',
    };
    expect(Object.keys(probe).sort()).toEqual(writes.map((r) => r.id).sort());
    for (const [risk, slice] of Object.entries(probe)) {
      expect(risksTouchedBy(parseSlice(slice), notionCatalog.indexed), slice).toEqual([risk]);
    }
    expect(
      risksTouchedBy(parseSlice('notion.root[r].block[b].comment[d].W'), notionCatalog.indexed),
    ).toEqual(['notion.comment-create']);
  });

  test('trashing the root page touches page-trash and root-trash', () => {
    const args = { page_id: pageRoot.ref };
    expect(touched('notion__trash_page', args, [pageRoot])).toEqual([
      ['notion.page-trash'],
      ['notion.root-trash'],
    ]);
  });

  test('no environment : no env-scoped entity, risk, override or macro-action entry', () => {
    const entities = notionDataModel.planes.flatMap((p) => p.entities);
    expect(entities.some((e) => e.envScopable)).toBe(false);
    for (const risk of notionCatalog.catalog.risks) {
      expect(risk.acceptable_in_envs, risk.id).toBeUndefined();
      expect(risk.vector_overrides, risk.id).toBeUndefined();
    }
    for (const entry of notionCatalog.catalog.macro_actions.flatMap((a) => a.entries)) {
      expect(entry.risk_id).toMatch(/^notion\.[a-z-]+$/);
    }
    expect('envOf' in notionPlugin).toBe(false);
  });

  test('reads are never priced as writes, and the fallback catches no realistic call', () => {
    for (const slice of [
      'notion.root[r].R',
      'notion.root[r].page[*].R',
      'notion.root[r].block[b].comment[*].R',
    ]) {
      const risks = risksTouchedBy(parseSlice(slice), notionCatalog.indexed);
      expect(risks.length).toBe(1);
      expect(risks[0]).not.toBe('notion.uncategorized-write');
    }
  });
});
