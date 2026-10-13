import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/plugin-sdk';

import { gmailDataModel } from '../../src/index.ts';

describe('gmailDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(gmailDataModel)).toEqual([]);
  });

  test('declares exactly one plane (mailbox)', () => {
    expect(gmailDataModel.planes).toHaveLength(1);
    expect(gmailDataModel.planes[0]!.slug).toBe('mailbox');
  });

  test('mailbox is the envScopable entity (plane root)', () => {
    const mailbox = gmailDataModel.planes[0]!.entities.find((e) => e.name === 'mailbox');
    expect(mailbox).toBeDefined();
    expect(mailbox!.envScopable).toBe(true);
  });

  test('declares the 4 synthetic risk-zone markers under mailbox', () => {
    const entities = gmailDataModel.planes[0]!.entities;
    const synthetic = ['from-zone', 'to-zone', 'bulk-marker', 'sensitive-label'];
    for (const slug of synthetic) {
      const e = entities.find((x) => x.name === slug);
      expect(e, `synthetic entity '${slug}' must be declared`).toBeDefined();
      expect(e!.parent).toBe('mailbox');
    }
  });

  test('thread cardinality is unbounded (potentially infinite history)', () => {
    const thread = gmailDataModel.planes[0]!.entities.find((e) => e.name === 'thread');
    expect(thread).toBeDefined();
    expect(thread!.cardinalities).toContain('unbounded');
  });
});
