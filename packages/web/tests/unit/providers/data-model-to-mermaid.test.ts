/**
 * Unit tests for the data-model → mermaid ER renderer. The renderer is
 * the canonical viewer of the policy-engine threat model — silent
 * regressions here mean confusing UI for the security reviewer.
 */

import { describe, expect, it } from 'vitest';

import type { DataModel } from '@vaubaan/shared';

import {
  dataModelToMermaid,
  entityNodeId,
  renderDataModelMermaid,
} from '@/components/providers/data-model-to-mermaid';

const SAMPLE_MODEL: DataModel = {
  provider: 'test',
  planes: [
    {
      slug: 'repo',
      entities: [
        { name: 'repo', parent: null, cardinalities: ['one'], description: 'r' },
        { name: 'branch', parent: 'repo', cardinalities: ['bounded'], description: 'b' },
        { name: 'file', parent: 'branch', cardinalities: ['unbounded'], description: 'f' },
      ],
    },
    {
      slug: 'storage',
      entities: [
        { name: 'project', parent: null, cardinalities: ['one'], description: 'p' },
        { name: 'bucket', parent: 'project', cardinalities: ['bounded'], description: 'b' },
      ],
    },
  ],
};

describe('data-model-to-mermaid (ER)', () => {
  it('emits the erDiagram header', () => {
    const src = dataModelToMermaid(SAMPLE_MODEL);
    expect(src.startsWith('erDiagram')).toBe(true);
  });

  it('declares every entity with an attribute block', () => {
    const src = dataModelToMermaid(SAMPLE_MODEL);
    expect(src).toContain(`${entityNodeId('repo', 'repo')} { }`);
    expect(src).toContain(`${entityNodeId('repo', 'branch')} { }`);
    expect(src).toContain(`${entityNodeId('repo', 'file')} { }`);
  });

  it('emits a one-to-many edge for bounded child cardinality', () => {
    const src = dataModelToMermaid(SAMPLE_MODEL);
    const repo = entityNodeId('repo', 'repo');
    const branch = entityNodeId('repo', 'branch');
    expect(src).toContain(`${repo} ||--o{ ${branch} : "has"`);
  });

  it('emits a one-to-many edge for unbounded child cardinality', () => {
    const src = dataModelToMermaid(SAMPLE_MODEL);
    const branch = entityNodeId('repo', 'branch');
    const file = entityNodeId('repo', 'file');
    expect(src).toContain(`${branch} ||--o{ ${file} : "has"`);
  });

  it('filters to a single plane via planeSlug', () => {
    const src = dataModelToMermaid(SAMPLE_MODEL, { planeSlug: 'storage' });
    expect(src).toContain(entityNodeId('storage', 'bucket'));
    expect(src).not.toContain(entityNodeId('repo', 'branch'));
  });

  it('marks the root entity as ORG binding via classDef', () => {
    const { source, highlights } = renderDataModelMermaid(SAMPLE_MODEL, {
      planeSlug: 'repo',
    });
    const repoId = entityNodeId('repo', 'repo');
    expect(highlights.get(repoId)).toBe('org');
    expect(source).toContain('classDef orgBinding');
    expect(source).toContain(`class ${repoId} orgBinding`);
  });

  it('emits exactly one classDef block when highlights are present', () => {
    const src = dataModelToMermaid(SAMPLE_MODEL, { planeSlug: 'repo' });
    const orgDefs = src.match(/classDef orgBinding/g) ?? [];
    expect(orgDefs.length).toBe(1);
  });
});
