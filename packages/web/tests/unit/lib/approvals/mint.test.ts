/**
 * Unit tests for the unified-tokens mint helpers.
 *
 * Spec : ADR unified-tokens-delegation-chain-and-escalation-channel.md.
 */
import { describe, expect, test, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  mintChildToken,
  mintChildForApproval,
  MintInvariantError,
  computeChildChain,
  type MintParent,
} from '@/lib/approvals/mint';

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

const rootOrgCarteBlanche: MintParent = {
  id: 'root_1',
  name: 'root-mgmt',
  organization_id: 'org_1',
  scope: 'org',
  project_id: null,
  accepted_risks: [],
  denied_risks: [],
  depth: 0,
  delegation_chain: [],
  expires_at: null,
  created_at: '2026-01-01T00:00:00Z',
  created_by: 'usr_1',
};

const projectParentWithRisks: MintParent = {
  id: 'parent_1',
  name: 'story-dev',
  organization_id: 'org_1',
  scope: 'project',
  project_id: 'proj_1',
  accepted_risks: ['github.read-code', 'supabase.read-data'],
  denied_risks: ['supabase.policy.W'],
  depth: 1,
  delegation_chain: [
    {
      id: 'root_1',
      name: 'root-mgmt',
      depth: 0,
      scope: 'org',
      created_at: '2026-01-01T00:00:00Z',
      created_by: 'usr_1',
    },
  ],
  expires_at: '2026-12-31T23:59:59Z',
  created_at: '2026-06-01T00:00:00Z',
  created_by: 'usr_1',
};

describe('computeChildChain', () => {
  test('appends the parent to the parent chain', () => {
    const chain = computeChildChain(projectParentWithRisks);
    expect(chain).toHaveLength(2);
    expect(chain[1]!.id).toBe('parent_1');
  });

  test('root parent produces a chain of length 1', () => {
    expect(computeChildChain(rootOrgCarteBlanche)).toHaveLength(1);
  });
});

describe('mintChildToken — invariants', () => {
  test('rejects subset-violation when parent does not hold the requested risk', async () => {
    const { client } = makeMockSupabase();
    await expect(
      mintChildToken(client, {
        parent: projectParentWithRisks,
        tokenName: 'child',
        scope: 'project',
        projectId: 'proj_1',
        ttlMs: 1000,
        accepted_risks: ['github.write-code'],
      }),
    ).rejects.toBeInstanceOf(MintInvariantError);
  });

  test('rejects max-depth violation', async () => {
    const { client } = makeMockSupabase();
    const deepParent: MintParent = { ...projectParentWithRisks, depth: 5 };
    await expect(
      mintChildToken(client, {
        parent: deepParent,
        tokenName: 'child',
        scope: 'project',
        projectId: 'proj_1',
        ttlMs: 1000,
        accepted_risks: [],
      }),
    ).rejects.toBeInstanceOf(MintInvariantError);
  });

  test('rejects child expires_at past parent expires_at', async () => {
    const { client } = makeMockSupabase();
    const parentExpiresSoon: MintParent = {
      ...projectParentWithRisks,
      expires_at: new Date(Date.now() + 1000).toISOString(),
    };
    await expect(
      mintChildToken(client, {
        parent: parentExpiresSoon,
        tokenName: 'child',
        scope: 'project',
        projectId: 'proj_1',
        ttlMs: 60_000,
        accepted_risks: [],
        denied_risks: parentExpiresSoon.denied_risks,
      }),
    ).rejects.toBeInstanceOf(MintInvariantError);
  });

  test('rejects child missing parent denied_risks', async () => {
    const { client } = makeMockSupabase();
    await expect(
      mintChildToken(client, {
        parent: projectParentWithRisks,
        tokenName: 'child',
        scope: 'project',
        projectId: 'proj_1',
        ttlMs: 1000,
        accepted_risks: ['github.read-code'],
        denied_risks: [], // parent has ['supabase.policy.W'] → must inherit
      }),
    ).rejects.toBeInstanceOf(MintInvariantError);
  });

  test('rejects org→project scope mismatch on project-only parents', async () => {
    const { client } = makeMockSupabase();
    await expect(
      mintChildToken(client, {
        parent: projectParentWithRisks,
        tokenName: 'child',
        scope: 'org',
        ttlMs: 1000,
        accepted_risks: [],
        denied_risks: projectParentWithRisks.denied_risks,
      }),
    ).rejects.toBeInstanceOf(MintInvariantError);
  });

  test('rejects scope=project without projectId', async () => {
    const { client } = makeMockSupabase();
    await expect(
      mintChildToken(client, {
        parent: rootOrgCarteBlanche,
        tokenName: 'child',
        scope: 'project',
        // no projectId
        ttlMs: 1000,
        accepted_risks: [],
      }),
    ).rejects.toBeInstanceOf(MintInvariantError);
  });

  test('rejects scope=org with a projectId set', async () => {
    const { client } = makeMockSupabase();
    await expect(
      mintChildToken(client, {
        parent: rootOrgCarteBlanche,
        tokenName: 'child',
        scope: 'org',
        projectId: 'proj_1',
        ttlMs: 1000,
        accepted_risks: [],
      }),
    ).rejects.toBeInstanceOf(MintInvariantError);
  });
});

describe('mintChildToken — happy path', () => {
  test('mints a child from a project parent with valid subset', async () => {
    const { client, inserts } = makeMockSupabase();
    const result = await mintChildToken(client, {
      parent: projectParentWithRisks,
      tokenName: 'coding-agent',
      scope: 'project',
      projectId: 'proj_1',
      ttlMs: 3600 * 1000,
      accepted_risks: ['github.read-code'],
      denied_risks: ['supabase.policy.W'], // inherits parent's
    });

    expect(result.tokenId).toBe('tok_test_123');
    expect(result.apiKey).toMatch(/^vbn_live_/);
    expect(result.delegationChain).toHaveLength(2);

    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.row;
    expect(inserts[0]!.table).toBe('tokens');
    expect(row.parent_id).toBe('parent_1');
    expect(row.scope).toBe('project');
    expect(row.project_id).toBe('proj_1');
    expect(row.depth).toBe(2);
    expect(row.accepted_risks).toEqual(['github.read-code']);
    expect(row.denied_risks).toEqual(['supabase.policy.W']);
    expect(row.status).toBe('active');
  });

  test('carte-blanche root org parent bypasses the subset check', async () => {
    const { client, inserts } = makeMockSupabase();
    await mintChildToken(client, {
      parent: rootOrgCarteBlanche,
      tokenName: 'story-dev',
      scope: 'project',
      projectId: 'proj_1',
      ttlMs: 3600 * 1000,
      accepted_risks: ['github.read-code', 'supabase.read-data'],
    });
    const row = inserts[0]!.row;
    expect(row.accepted_risks).toEqual(['github.read-code', 'supabase.read-data']);
    expect(row.depth).toBe(1);
  });
});

describe('mintChildForApproval', () => {
  test('stashes the api_key on the approval row', async () => {
    const { client, inserts, updates } = makeMockSupabase();
    const result = await mintChildForApproval(client, 'appr_xyz', {
      parent: rootOrgCarteBlanche,
      tokenName: 'child',
      scope: 'project',
      projectId: 'proj_1',
      ttlMs: 60_000,
      accepted_risks: ['github.read-code'],
    });
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe('approval_requests');
    expect(updates[0]!.patch.access_token_id).toBe('tok_test_123');
    expect(updates[0]!.patch.pending_api_key).toBe(result.apiKey);
    expect(updates[0]!.where).toEqual({ col: 'id', val: 'appr_xyz' });
  });
});
