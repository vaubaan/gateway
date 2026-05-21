/**
 * Tests for the `db` SecretManager — the default v1 backend backed by
 * Postgres `resource_access.sealed_blob` (bytea).
 *
 * We mock the supabase-js client as a tiny chainable in-memory store. The
 * test asserts:
 *   - put encodes the blob as `\x<hex>` (canonical bytea text literal),
 *   - get decodes the bytea back to the canonical JSON shape,
 *   - list enumerates the access keys under a resource,
 *   - revoke removes the row.
 */

import { describe, it, expect } from 'vitest';

import {
  createDbSecretManager,
  decodeSealedBytea,
  encodeSealedBytea,
  type DbSupabaseLike,
} from '../../../src/secret-manager/db.js';
import type { SealedBlob } from '../../../src/secret-manager/interface.js';

interface Row {
  resource_id: string;
  key: string;
  sealed_blob: string;
}

function makeFakeSupabase(initial: Row[] = []): {
  client: DbSupabaseLike;
  rows: Row[];
} {
  const rows: Row[] = [...initial];

  function table(name: string) {
    if (name !== 'resource_access') throw new Error(`unexpected table ${name}`);

    return {
      select(_cols: string) {
        const eqs: Array<[string, unknown]> = [];
        const chain = {
          eq(col: string, val: unknown) {
            eqs.push([col, val]);
            return chain;
          },
          order(_col: string, _opts: { ascending: boolean }) {
            const matched = rows.filter((r) =>
              eqs.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v),
            );
            matched.sort((a, b) => a.key.localeCompare(b.key));
            return Promise.resolve({ data: matched.map((r) => ({ key: r.key })), error: null });
          },
          maybeSingle() {
            const matched = rows.filter((r) =>
              eqs.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v),
            );
            return Promise.resolve({
              data: matched[0] ? { sealed_blob: matched[0].sealed_blob } : null,
              error: null,
            });
          },
        };
        return chain;
      },
      upsert(row: Record<string, unknown>, _opts: { onConflict?: string }) {
        const idx = rows.findIndex((r) => r.resource_id === row.resource_id && r.key === row.key);
        const newRow: Row = {
          resource_id: row.resource_id as string,
          key: row.key as string,
          sealed_blob: row.sealed_blob as string,
        };
        if (idx >= 0) rows[idx] = newRow;
        else rows.push(newRow);
        return Promise.resolve({ data: null, error: null });
      },
      delete() {
        const eqs: Array<[string, unknown]> = [];
        const chain = {
          eq(col: string, val: unknown) {
            eqs.push([col, val]);
            if (eqs.length === 2) {
              const remaining = rows.filter(
                (r) => !eqs.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v),
              );
              rows.length = 0;
              rows.push(...remaining);
              return Promise.resolve({ data: null, error: null });
            }
            return chain;
          },
        };
        return chain;
      },
    };
  }

  return { client: { from: table } as unknown as DbSupabaseLike, rows };
}

const blob: SealedBlob = {
  v: 1,
  recipients: [
    { fp: '0123456789abcdef0123456789abcdef', ct: 'AAAA' },
    { fp: 'fedcba9876543210fedcba9876543210', ct: 'BBBB' },
  ],
};

describe('db SecretManager — encode/decode helpers', () => {
  it('encodeSealedBytea returns a `\\x<hex>` text literal, decodes back to JSON', () => {
    const encoded = encodeSealedBytea(blob);
    expect(encoded.startsWith('\\x')).toBe(true);
    expect(decodeSealedBytea(encoded)).toEqual(blob);
  });

  it('decodeSealedBytea returns null on corrupt JSON', () => {
    expect(decodeSealedBytea('\\x4f4f4f')).toBeNull(); // "OOO" — not JSON
  });

  it('decodeSealedBytea returns null on a JSON value that is not a SealedBlob', () => {
    const bad = encodeSealedBytea({ v: 2, recipients: [] } as unknown as SealedBlob);
    expect(decodeSealedBytea(bad)).toBeNull();
  });
});

describe('db SecretManager — CRUD', () => {
  it('put then get round-trip the canonical SealedBlob via bytea', async () => {
    const { client, rows } = makeFakeSupabase();
    const sm = createDbSecretManager({ supabase: client });
    expect(sm.kind).toBe('db');
    expect(sm.name).toBe('default');
    await sm.put('res-1', 'main', blob);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sealed_blob.startsWith('\\x')).toBe(true);
    const out = await sm.get('res-1', 'main');
    expect(out).toEqual(blob);
  });

  it('get returns null on missing row', async () => {
    const { client } = makeFakeSupabase();
    const sm = createDbSecretManager({ supabase: client });
    const out = await sm.get('res-1', 'main');
    expect(out).toBeNull();
  });

  it('list returns the access keys for a resource', async () => {
    const { client } = makeFakeSupabase();
    const sm = createDbSecretManager({ supabase: client });
    await sm.put('res-1', 'main', blob);
    await sm.put('res-1', 'admin', blob);
    await sm.put('res-2', 'main', blob);
    const keys = await sm.list!('res-1');
    expect([...keys].sort()).toEqual(['admin', 'main']);
  });

  it('revoke deletes the row and is idempotent', async () => {
    const { client, rows } = makeFakeSupabase();
    const sm = createDbSecretManager({ supabase: client });
    await sm.put('res-1', 'main', blob);
    await sm.revoke('res-1', 'main');
    expect(rows).toHaveLength(0);
    await expect(sm.revoke('res-1', 'main')).resolves.toBeUndefined();
  });
});
