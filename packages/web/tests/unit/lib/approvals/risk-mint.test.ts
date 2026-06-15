/**
 * Unit tests for the v4 mint helpers.
 *
 * We use a minimal in-memory mock of the Supabase client surface we touch
 * — just `from('access_tokens').insert(...).select(...).single()` and
 * `from('approval_requests').update(...).eq(...)`.
 */
import { describe, expect, test, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { mintForApprovalV4, mintRiskAccessToken } from '@/lib/approvals/risk-mint';

interface CapturedInsert {
  table: string;
  row: Record<string, unknown>;
}
interface CapturedUpdate {
  table: string;
  patch: Record<string, unknown>;
  where: { col: string; val: unknown };
}

function makeMockSupabase(): {
  client: SupabaseClient;
  inserts: CapturedInsert[];
  updates: CapturedUpdate[];
  insertedId: string;
} {
  const inserts: CapturedInsert[] = [];
  const updates: CapturedUpdate[] = [];
  const insertedId = 'tok_test_123';
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return {
            select(_cols: string) {
              return {
                single: vi.fn().mockResolvedValue({
                  data: { id: insertedId },
                  error: null,
                }),
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              updates.push({ table, patch, where: { col, val } });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, inserts, updates, insertedId };
}

describe('mintRiskAccessToken', () => {
  test('writes accepted_risks + denied_risks + empty capabilities to access_tokens', async () => {
    const { client, inserts } = makeMockSupabase();
    const result = await mintRiskAccessToken(client, {
      projectId: 'p1',
      tokenName: 'mgmt-x',
      ttlMs: 3_600_000,
      accepted_risks: ['supabase.read-data', 'supabase[staging].bulk-row-write'],
      denied_risks: ['supabase.policy.W'],
      singleUse: false,
    });
    expect(result.accessTokenId).toBe('tok_test_123');
    expect(result.apiKey).toMatch(/^vbn_live_/);
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.row;
    expect(inserts[0]!.table).toBe('access_tokens');
    expect(row.project_id).toBe('p1');
    expect(row.accepted_risks).toEqual(['supabase.read-data', 'supabase[staging].bulk-row-write']);
    expect(row.denied_risks).toEqual(['supabase.policy.W']);
    // v1 capabilities[] kept as empty for dual-mode FK
    expect(row.capabilities).toEqual([]);
    expect(row.status).toBe('active');
    expect(row.single_use).toBe(false);
  });

  test('defaults denied_risks to empty array and singleUse to false', async () => {
    const { client, inserts } = makeMockSupabase();
    await mintRiskAccessToken(client, {
      projectId: 'p1',
      tokenName: 't',
      ttlMs: 60_000,
      accepted_risks: ['supabase.read-data'],
    });
    expect(inserts[0]!.row.denied_risks).toEqual([]);
    expect(inserts[0]!.row.single_use).toBe(false);
  });
});

describe('mintForApprovalV4', () => {
  test('mints + stashes api_key on the approval row', async () => {
    const { client, inserts, updates } = makeMockSupabase();
    const result = await mintForApprovalV4(client, 'appr_xyz', {
      projectId: 'p1',
      tokenName: 'mgmt-y',
      ttlMs: 60_000,
      accepted_risks: ['supabase.read-data'],
    });
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe('approval_requests');
    expect(updates[0]!.patch.access_token_id).toBe('tok_test_123');
    expect(updates[0]!.patch.pending_api_key).toBe(result.apiKey);
    expect(updates[0]!.where).toEqual({ col: 'id', val: 'appr_xyz' });
  });
});
