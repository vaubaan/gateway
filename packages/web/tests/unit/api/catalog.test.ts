import { describe, expect, it } from 'vitest';

import {
  GET as listGET,
  type CatalogListResponse,
} from '../../../src/app/api/crm/v1/catalog/route.js';
import {
  GET as byIdGET,
  type CatalogKindResponse,
  type CatalogErrorResponse,
} from '../../../src/app/api/crm/v1/catalog/[kindId]/route.js';
import type { SerializedKind } from '../../../src/lib/catalog/serialize.js';

/**
 * Spec §6.1 — `GET /api/crm/v1/catalog` + `GET /api/crm/v1/catalog/:kindId`.
 *
 * These tests exercise the Next.js route handlers directly (no HTTP
 * server). They cover the wire format and the 404 path.
 */

function makeCtx(kindId: string) {
  return { params: Promise.resolve({ kindId }) };
}

describe('GET /api/crm/v1/catalog (list)', () => {
  it('returns 200 with a kinds array of length 9 (v1 inventory)', async () => {
    const res = listGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogListResponse;
    expect(Array.isArray(body.kinds)).toBe(true);
    expect(body.kinds).toHaveLength(9);
  });

  it('emits only serialisable fields (no functions on the wire)', async () => {
    const res = listGET();
    const body = (await res.json()) as CatalogListResponse;
    for (const k of body.kinds) {
      const indexed = k as unknown as Record<string, unknown>;
      expect(indexed.healthTestCmd).toBeUndefined();
      expect(indexed.mcpFragment).toBeUndefined();
      expect(indexed.rotateSelf).toBeUndefined();
      expect(indexed.listChildren).toBeUndefined();
      expect(indexed.createChild).toBeUndefined();
      expect(indexed.destroyChild).toBeUndefined();
      expect(indexed.rotateChildAccess).toBeUndefined();
      // metadataSchema is implementation-defined and intentionally
      // not on the wire either (kept out of `SerializedKind`).
      expect(indexed.metadataSchema).toBeUndefined();
    }
  });

  it('every kind carries id, provider, kindClass, displayName, setupDocs, accessSchema, rotationMethod, egressHosts', async () => {
    const res = listGET();
    const body = (await res.json()) as CatalogListResponse;
    for (const k of body.kinds) {
      expect(k.id).toBeTypeOf('string');
      expect(k.id.length).toBeGreaterThan(0);
      expect(k.provider).toBeTypeOf('string');
      expect(['org', 'project', 'org-admin']).toContain(k.kindClass);
      expect(k.displayName).toBeTypeOf('string');
      expect(k.setupDocs.length).toBeGreaterThanOrEqual(100);
      expect(Object.keys(k.accessSchema).length).toBeGreaterThan(0);
      expect(['self', 'admin-mediated', 'manual']).toContain(k.rotationMethod);
      expect(Array.isArray(k.egressHosts)).toBe(true);
    }
  });

  it('org-admin kinds carry a non-empty manages: [...]', async () => {
    const res = listGET();
    const body = (await res.json()) as CatalogListResponse;
    const admins = body.kinds.filter(
      (k): k is SerializedKind & { manages: readonly string[] } => k.kindClass === 'org-admin',
    );
    expect(admins.length).toBeGreaterThan(0);
    for (const a of admins) {
      expect(a.manages).toBeDefined();
      expect(a.manages.length).toBeGreaterThan(0);
    }
  });

  it('exposes the expected v1 kind ids', async () => {
    const res = listGET();
    const body = (await res.json()) as CatalogListResponse;
    const ids = new Set(body.kinds.map((k) => k.id));
    expect(ids).toEqual(
      new Set([
        'github-org',
        'github-org-admin',
        'github-repo',
        'vercel-team',
        'vercel-team-admin',
        'vercel-project',
        'supabase-org',
        'supabase-org-admin',
        'supabase-project',
      ]),
    );
  });

  it('sets a public Cache-Control header', () => {
    const res = listGET();
    const cc = res.headers.get('cache-control');
    expect(cc).toBeTruthy();
    expect(cc!).toMatch(/public/);
    expect(cc!).toMatch(/max-age=\d+/);
  });
});

describe('GET /api/crm/v1/catalog/:kindId (by id)', () => {
  it('returns 200 with the kind body for a known id', async () => {
    const res = await byIdGET(new Request('http://x/'), makeCtx('github-org'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogKindResponse;
    expect(body.kind.id).toBe('github-org');
    expect(body.kind.provider).toBe('github');
    expect(body.kind.kindClass).toBe('org');
    expect(body.kind.setupDocs.length).toBeGreaterThanOrEqual(100);
  });

  it('returns the setupDocs markdown as plain text', async () => {
    const res = await byIdGET(new Request('http://x/'), makeCtx('supabase-org-admin'));
    const body = (await res.json()) as CatalogKindResponse;
    expect(body.kind.setupDocs).toMatch(/^##|#\s/m);
    expect(body.kind.kindClass).toBe('org-admin');
    const admin = body.kind as SerializedKind & { manages: readonly string[] };
    expect(admin.manages).toEqual(['supabase-project']);
  });

  it('returns 404 + unknown_kind on a missing id', async () => {
    const res = await byIdGET(new Request('http://x/'), makeCtx('nope-not-a-kind'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as CatalogErrorResponse;
    expect(body.error).toBe('unknown_kind');
    expect(body.kindId).toBe('nope-not-a-kind');
  });

  it('does not emit functions on the wire (single-kind path)', async () => {
    const res = await byIdGET(new Request('http://x/'), makeCtx('vercel-team-admin'));
    const body = (await res.json()) as CatalogKindResponse;
    const indexed = body.kind as unknown as Record<string, unknown>;
    expect(indexed.healthTestCmd).toBeUndefined();
    expect(indexed.mcpFragment).toBeUndefined();
    expect(indexed.listChildren).toBeUndefined();
    expect(indexed.createChild).toBeUndefined();
    expect(indexed.destroyChild).toBeUndefined();
    expect(indexed.rotateChildAccess).toBeUndefined();
  });
});
