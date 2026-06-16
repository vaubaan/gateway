/**
 * Unit tests for the `McpGateway.handle` path — focused on the audit trail
 * shape on success / failure / binding-missing branches.
 *
 * What we cover here :
 *  - B1 — upstream throws after single-use consume → audit decision='denied'
 *    with denial_reason carrying `upstream-error:` prefix and the message.
 *  - B2 — classifier accepted the call but no binding for that provider on
 *    the access token → audit decision='denied' with `binding-missing` reason.
 */
import { describe, expect, test } from 'vitest';
import type {
  AccessTokenContext,
  McpToolDeclaration,
  Provider,
  ProviderAdmin,
  ProviderBinding,
  RiskCatalog,
  Slice,
} from '@vaubaan/shared';
import { indexCatalog } from '@vaubaan/policy-engine';

import { MemoryAuditWriter } from '../../src/audit.ts';
import { MemoryCacheClient } from '../../src/cache.ts';
import {
  McpGateway,
  type ContextLoader,
  type GatewayConfig,
  type UpstreamAdapter,
} from '../../src/gateway.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const supabaseCatalog: RiskCatalog = {
  provider: 'supabase',
  risks: [
    {
      id: 'supabase.read-data',
      label: 'Read',
      reason: 'reads',
      matches: 'supabase.**.R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
  ],
};

function makeReadSlice(projectRef: string): Slice {
  return {
    provider: 'supabase',
    path: [
      { kind: 'name', value: 'project' },
      { kind: 'ident', value: projectRef },
      { kind: 'name', value: 'schema' },
      { kind: 'ident', value: 'any' },
      { kind: 'name', value: 'row' },
      { kind: 'ident', value: 'bulk' },
    ],
    action: 'R',
  };
}

function makeContext(opts: { bindings: ProviderBinding[] }): AccessTokenContext {
  return {
    access_token: {
      id: 'tok_test',
      name: 'test',
      parent_id: null,
      scope: 'project',
      project_id: 'proj_test',
      status: 'active',
      api_key_prefix: 'vbn_live_abcd',
      expires_at: null,
      single_use: false,
      consumed_at: null,
      depth: 0,
      delegation_chain: [],
    },
    project: { id: 'proj_test', slug: 'p1', organization_id: 'org_test' },
    organization: { id: 'org_test', slug: 'org', name: 'Org' },
    accepted_risks: ['supabase.read-data'],
    denied_risks: [],
    bindings: opts.bindings,
    provider_admins: [
      { provider: 'supabase', status: 'connected', installation_id: null, team_id: null },
    ],
  };
}

function makeAdapter(opts: {
  executeCall?: () => Promise<unknown>;
  selfContained?: boolean;
  executeCallSelfContained?: () => Promise<unknown>;
}): UpstreamAdapter {
  const tools: McpToolDeclaration[] = [
    { name: 'supabase__execute_sql', description: 'exec', inputSchema: { type: 'object' } },
  ];
  return {
    provider: 'supabase',
    availableTools: tools,
    classifyV4: () => ({ slices: [makeReadSlice('prj_x')] }),
    executeCall: opts.executeCall ?? (async () => ({ ok: true })),
    loadProviderAdmin: async (): Promise<ProviderAdmin | null> =>
      ({
        id: 'pa1',
        organization_id: 'org_test',
        provider: 'supabase' as Provider,
        status: 'connected',
        installation_id: null,
        team_id: null,
        access_token_enc: null,
        refresh_token_enc: null,
        token_expires_at: null,
        created_at: '2026-01-01',
      }) as unknown as ProviderAdmin,
    selfContained: opts.selfContained,
    executeCallSelfContained: opts.executeCallSelfContained,
  };
}

function makeLoader(ctx: AccessTokenContext): ContextLoader {
  return {
    loadAccessTokenForAuth: async () => ({
      id: ctx.access_token.id,
      api_key_hash: '',
      status: 'active',
    }),
    loadAccessTokenContext: async () => ctx,
  };
}

function makeGateway(opts: {
  ctx: AccessTokenContext;
  adapter: UpstreamAdapter;
  audit: MemoryAuditWriter;
}): McpGateway {
  const cfg: GatewayConfig = {
    cache: new MemoryCacheClient(),
    audit: opts.audit,
    contextLoader: makeLoader(opts.ctx),
    upstreamByProvider: {
      supabase: opts.adapter,
    } as unknown as GatewayConfig['upstreamByProvider'],
    catalogByProvider: { supabase: indexCatalog(supabaseCatalog) },
  };
  return new McpGateway(cfg);
}

const validBinding: ProviderBinding = {
  id: 'b1',
  project_id: 'proj_test',
  provider: 'supabase',
  resource_ref: 'prj_x',
  display_name: null,
  created_at: '2026-01-01',
};

// ─── B1 tests ────────────────────────────────────────────────────────────────

describe('McpGateway.callTool — B1 upstream-error audit shape', () => {
  test('regular adapter: upstream throw → audit decision=denied with upstream-error reason', async () => {
    const audit = new MemoryAuditWriter();
    const ctx = makeContext({ bindings: [validBinding] });
    const adapter = makeAdapter({
      executeCall: async () => {
        throw new Error('boom');
      },
    });
    const gw = makeGateway({ ctx, adapter, audit });

    const resp = await gw.handle(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'supabase__execute_sql', arguments: {} },
    });

    expect('error' in resp).toBe(true);
    expect(audit.rows.length).toBe(1);
    const row = audit.rows[0]!;
    expect(row.decision).toBe('denied');
    expect(row.denial_reason).toMatch(/^upstream-error:/);
    expect(row.denial_reason).toContain('boom');
    // We still record the risks_touched + slices_executed for forensics.
    expect(row.risks_touched).toEqual(['supabase.read-data']);
    expect(row.slices_executed).not.toBeNull();
  });

  test('self-contained adapter: upstream throw → audit decision=denied with upstream-error reason', async () => {
    const audit = new MemoryAuditWriter();
    const ctx = makeContext({ bindings: [validBinding] });
    const adapter = makeAdapter({
      selfContained: true,
      executeCallSelfContained: async () => {
        throw new Error('ssh-broke');
      },
    });
    const gw = makeGateway({ ctx, adapter, audit });

    const resp = await gw.handle(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'supabase__execute_sql', arguments: {} },
    });

    expect('error' in resp).toBe(true);
    expect(audit.rows.length).toBe(1);
    const row = audit.rows[0]!;
    expect(row.decision).toBe('denied');
    expect(row.denial_reason).toContain('upstream-error');
    expect(row.denial_reason).toContain('ssh-broke');
  });
});

// ─── B2 tests ────────────────────────────────────────────────────────────────

describe('McpGateway.callTool — B2 missing binding', () => {
  test('classifier accepts call but no binding → audit denied with binding-missing reason', async () => {
    const audit = new MemoryAuditWriter();
    // Note: emptying bindings — the classifier still returns slices because
    // our makeAdapter() returns a hardcoded slice regardless.
    const ctx = makeContext({ bindings: [] });
    const adapter = makeAdapter({});
    const gw = makeGateway({ ctx, adapter, audit });

    const resp = await gw.handle(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'supabase__execute_sql', arguments: {} },
    });

    expect('error' in resp).toBe(true);
    expect(audit.rows.length).toBe(1);
    const row = audit.rows[0]!;
    expect(row.decision).toBe('denied');
    expect(row.denial_reason).toContain('binding-missing');
  });
});

// ─── Sanity: happy path still audits allowed ─────────────────────────────────

describe('McpGateway.callTool — happy path', () => {
  test('successful upstream call → audit decision=allowed', async () => {
    const audit = new MemoryAuditWriter();
    const ctx = makeContext({ bindings: [validBinding] });
    const adapter = makeAdapter({ executeCall: async () => ({ rows: [] }) });
    const gw = makeGateway({ ctx, adapter, audit });

    const resp = await gw.handle(ctx, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'supabase__execute_sql', arguments: {} },
    });

    expect('result' in resp).toBe(true);
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.decision).toBe('allowed');
    expect(audit.rows[0]!.denial_reason).toBeNull();
  });
});
