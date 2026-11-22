/**
 * The catalog index after rolling a plugin back (ADR
 * plugins-activated-by-an-administrator-on-trial): a permission only a kept version knows
 * stays known, so a mission holding it can still be edited and saved; a malformed id or a
 * wildcard stays unknown.
 */
import { describe, expect, it } from 'vitest';

import { KeptCatalogIndex } from '@/server/compose/registry';
import { SetCatalogIndex } from '@/server/store/catalog-index';

describe('KeptCatalogIndex', () => {
  // The active (older) version knows contact-read; the kept newer one also knew contact-merge.
  const index = new KeptCatalogIndex(
    new SetCatalogIndex(['crm.contact-read']),
    new Set(['crm.contact-read', 'crm.contact-merge']),
  );

  it('knows a permission of the active version and one only a kept version knows', () => {
    expect(index.has('crm.contact-read')).toBe(true);
    expect(index.has('crm.contact-merge')).toBe(true);
    // Qualified by an environment, it is the same permission.
    expect(index.has('crm[prod].contact-merge')).toBe(true);
  });

  it('knows nothing no version of the plugin ever declared, nor a malformed id', () => {
    expect(index.has('crm.contact-delete')).toBe(false);
    expect(index.has('crm.*')).toBe(false);
    expect(index.has('not a risk id')).toBe(false);
  });
});
