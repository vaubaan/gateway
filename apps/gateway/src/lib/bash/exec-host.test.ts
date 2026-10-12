import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadHostByIdInOrg, loadHostBySlugInOrg } from './exec-host';

/**
 * Structural mock of just the `from().select().eq().eq().maybeSingle<T>()` chain
 * the production code under test uses. Cast once to `SupabaseClient` so the
 * production signatures stay strictly typed ; the cast is the price of not
 * spinning up a real Postgrest stub.
 */
interface SelectChain {
  select: (cols: string) => {
    eq: (
      col: string,
      value: string,
    ) => {
      eq: (
        col: string,
        value: string,
      ) => {
        maybeSingle: <T>() => Promise<{ data: T | null }>;
      };
    };
  };
}

function fakeSupabase(returns: unknown): {
  client: SupabaseClient;
  capturedSelect: { columns?: string };
  capturedEqs: Array<{ col: string; value: string }>;
} {
  const captured = { columns: undefined as string | undefined };
  const eqs: Array<{ col: string; value: string }> = [];
  const chain: SelectChain = {
    select(cols: string) {
      captured.columns = cols;
      return {
        eq(col: string, value: string) {
          eqs.push({ col, value });
          return {
            eq(col2: string, value2: string) {
              eqs.push({ col: col2, value: value2 });
              return {
                async maybeSingle<T>(): Promise<{ data: T | null }> {
                  return { data: returns as T | null };
                },
              };
            },
          };
        },
      };
    },
  };
  const client = { from: () => chain } as unknown as SupabaseClient;
  return { client, capturedSelect: captured, capturedEqs: eqs };
}

describe('loadHostByIdInOrg', () => {
  test('returns the host (without join keys) when org matches', async () => {
    const row = {
      id: 'h1',
      host_address: '1.2.3.4',
      port: 22,
      ssh_user: 'dev',
      ssh_private_key: '\\xdead',
      bash_bindings: { projects: { organization_id: 'org-1' } },
    };
    const { client } = fakeSupabase(row);
    const host = await loadHostByIdInOrg(client, {
      hostId: 'h1',
      bindingId: 'b1',
      orgId: 'org-1',
    });
    expect(host).toEqual({
      id: 'h1',
      host_address: '1.2.3.4',
      port: 22,
      ssh_user: 'dev',
      ssh_private_key: '\\xdead',
    });
  });

  test('returns null when org does NOT match (no existence leak)', async () => {
    const row = {
      id: 'h1',
      host_address: '1.2.3.4',
      port: 22,
      ssh_user: 'dev',
      ssh_private_key: '\\xdead',
      bash_bindings: { projects: { organization_id: 'OTHER-org' } },
    };
    const { client } = fakeSupabase(row);
    const host = await loadHostByIdInOrg(client, {
      hostId: 'h1',
      bindingId: 'b1',
      orgId: 'org-1',
    });
    expect(host).toBeNull();
  });

  test('returns null when no row is found', async () => {
    const { client } = fakeSupabase(null);
    const host = await loadHostByIdInOrg(client, {
      hostId: 'missing',
      bindingId: 'b1',
      orgId: 'org-1',
    });
    expect(host).toBeNull();
  });

  test('filters by hostId AND bindingId (both eq clauses are applied)', async () => {
    const { client, capturedEqs } = fakeSupabase(null);
    await loadHostByIdInOrg(client, { hostId: 'h1', bindingId: 'b1', orgId: 'org-1' });
    expect(capturedEqs).toEqual([
      { col: 'id', value: 'h1' },
      { col: 'bash_binding_id', value: 'b1' },
    ]);
  });
});

describe('loadHostBySlugInOrg', () => {
  test('returns the host (without join keys) when org matches', async () => {
    const row = {
      id: 'h1',
      host_address: '10.0.0.1',
      port: 2222,
      ssh_user: 'ops',
      ssh_private_key: '\\xbeef',
      bash_bindings: { projects: { organization_id: 'org-1' } },
    };
    const { client } = fakeSupabase(row);
    const host = await loadHostBySlugInOrg(client, {
      hostSlug: 'vps-rp',
      bindingId: 'b1',
      orgId: 'org-1',
    });
    expect(host).toEqual({
      id: 'h1',
      host_address: '10.0.0.1',
      port: 2222,
      ssh_user: 'ops',
      ssh_private_key: '\\xbeef',
    });
  });

  test('returns null when org does NOT match', async () => {
    const row = {
      id: 'h1',
      host_address: '10.0.0.1',
      port: 2222,
      ssh_user: 'ops',
      ssh_private_key: '\\xbeef',
      bash_bindings: { projects: { organization_id: 'INTRUDER' } },
    };
    const { client } = fakeSupabase(row);
    const host = await loadHostBySlugInOrg(client, {
      hostSlug: 'vps-rp',
      bindingId: 'b1',
      orgId: 'org-1',
    });
    expect(host).toBeNull();
  });

  test('filters by bindingId AND host_slug', async () => {
    const { client, capturedEqs } = fakeSupabase(null);
    await loadHostBySlugInOrg(client, {
      hostSlug: 'vps-rp',
      bindingId: 'b1',
      orgId: 'org-1',
    });
    expect(capturedEqs).toEqual([
      { col: 'bash_binding_id', value: 'b1' },
      { col: 'host_slug', value: 'vps-rp' },
    ]);
  });
});

// `execOnHost` is intentionally not unit-tested here : its happy path is a
// pure delegation to `sshExec` from the providers-ssh package (already
// covered by its own integration tests), and the invalid-key branch is a
// trivial conditional. Adding mocks around `sshExec` would test the
// mock, not our code.
beforeEach(() => {
  vi.restoreAllMocks();
});
