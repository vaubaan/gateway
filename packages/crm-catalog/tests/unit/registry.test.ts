import { describe, expect, it } from 'vitest';

import { CATALOG, findKind } from '../../src/index.js';
import type {
  KindClass,
  OrgResourceAdminKind,
  ResourceKind,
  RotationMethod,
} from '../../src/index.js';

/**
 * Spec §12.4 — structural invariants over the global `CATALOG`. These
 * are guard rails that fire any time someone adds a new provider kind
 * without respecting the discrimator / `manages` / rotation contracts.
 *
 * Per the v1 build plan we ship 9 kinds (3 per provider × 3 providers).
 */

const ALL_ROTATION_METHODS: readonly RotationMethod[] = ['self', 'admin-mediated', 'manual'];

const ALL_KIND_CLASSES: readonly KindClass[] = ['org', 'project', 'org-admin'];

function isOrgAdminKind(k: ResourceKind): k is OrgResourceAdminKind {
  return k.kindClass === 'org-admin';
}

describe('@crm/catalog registry', () => {
  it('ships exactly 9 ResourceKinds in v1', () => {
    expect(CATALOG).toHaveLength(9);
  });

  it('CATALOG is frozen', () => {
    expect(Object.isFrozen(CATALOG)).toBe(true);
  });

  it('all id values are unique', () => {
    const ids = CATALOG.map((k) => k.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every kindClass is one of {org, project, org-admin}', () => {
    for (const k of CATALOG) {
      expect(ALL_KIND_CLASSES).toContain(k.kindClass);
    }
  });

  it('every rotationMethod is one of {self, admin-mediated, manual}', () => {
    for (const k of CATALOG) {
      expect(ALL_ROTATION_METHODS).toContain(k.rotationMethod);
    }
  });

  it('every org-admin kind declares a non-empty manages: [...]', () => {
    const admins = CATALOG.filter(isOrgAdminKind);
    expect(admins.length).toBeGreaterThan(0);
    for (const a of admins) {
      expect(Array.isArray(a.manages)).toBe(true);
      expect(a.manages.length).toBeGreaterThan(0);
      // Every id in `manages` must resolve to an existing kind.
      for (const childId of a.manages) {
        const child = findKind(childId);
        expect(child, `${a.id} manages unknown kind ${childId}`).toBeDefined();
        expect(child!.kindClass).toBe('project');
      }
    }
  });

  it('every kind has a non-empty setupDocs (>= 100 chars)', () => {
    for (const k of CATALOG) {
      expect(k.setupDocs.length, `${k.id}.setupDocs too short`).toBeGreaterThanOrEqual(100);
    }
  });

  it('every kind has a non-empty accessSchema', () => {
    for (const k of CATALOG) {
      const keys = Object.keys(k.accessSchema);
      expect(keys.length, `${k.id}.accessSchema empty`).toBeGreaterThan(0);
    }
  });

  it('OrgResourceKind kinds are rotationMethod=manual (spec §0.1)', () => {
    const orgs = CATALOG.filter((k) => k.kindClass === 'org');
    expect(orgs.length).toBeGreaterThan(0);
    for (const o of orgs) {
      expect(o.rotationMethod, `${o.id} (org) must be manual`).toBe('manual');
    }
  });

  it('id values follow the slug grammar [a-z][a-z0-9-]*', () => {
    const slug = /^[a-z][a-z0-9-]*$/;
    for (const k of CATALOG) {
      expect(k.id).toMatch(slug);
    }
  });

  it('provider strings are in the v1 allowlist', () => {
    const allowed = new Set(['github', 'vercel', 'supabase-cloud']);
    for (const k of CATALOG) {
      expect(allowed.has(k.provider), `${k.id} provider=${k.provider} not in v1 allowlist`).toBe(
        true,
      );
    }
  });

  it('contains the expected v1 kinds (per build plan)', () => {
    const expected = new Set([
      'github-org',
      'github-org-admin',
      'github-repo',
      'vercel-team',
      'vercel-team-admin',
      'vercel-project',
      'supabase-org',
      'supabase-org-admin',
      'supabase-project',
    ]);
    const ids = new Set(CATALOG.map((k) => k.id));
    expect(ids).toEqual(expected);
  });
});

describe('@crm/catalog findKind helper', () => {
  it('returns the kind for a known id', () => {
    const k = findKind('github-org-admin');
    expect(k).toBeDefined();
    expect(k!.id).toBe('github-org-admin');
    expect(k!.kindClass).toBe('org-admin');
  });

  it('returns undefined for an unknown id', () => {
    expect(findKind('nope-not-a-kind')).toBeUndefined();
    expect(findKind('')).toBeUndefined();
  });

  it('returns a referentially-identical pointer (no cloning)', () => {
    const a = findKind('vercel-project');
    const b = findKind('vercel-project');
    expect(a).toBe(b);
    expect(a).toBe(CATALOG.find((k) => k.id === 'vercel-project'));
  });
});
