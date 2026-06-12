import { describe, expect, test } from 'vitest';
import type { Capability, McpToolDeclaration, ProviderBinding } from '@vaubaan/shared';
import {
  buildProviderCatalog,
  buildToolEntry,
  groupBindings,
  type ProviderSource,
} from './catalog.ts';

const cap = (
  provider: string,
  plane: string,
  level: string,
  action: 'read' | 'write',
  env?: string,
): Capability =>
  env ? { provider, plane, level, action, env } : { provider, plane, level, action };

const fakeTool = (name: string): McpToolDeclaration => ({
  name,
  description: `description of ${name}`,
  inputSchema: { type: 'object', properties: {}, required: [] },
});

const fakeSource = (): ProviderSource => ({
  slug: 'vercel',
  displayName: 'Vercel',
  tools: [fakeTool('vercel__list_deployments'), fakeTool('vercel__upsert_env_var')],
  capabilitiesOf: (name) => {
    if (name === 'vercel__list_deployments')
      return [cap('vercel', 'runtime', 'deployment', 'read')];
    if (name === 'vercel__upsert_env_var') return [cap('vercel', 'runtime', 'config', 'write')];
    return [];
  },
});

describe('buildToolEntry — granted=null (mgmt-key path)', () => {
  test('emits requiredCapabilities, no callable / no missingCapabilities', () => {
    const surface = [cap('vercel', 'runtime', 'config', 'write')];
    const entry = buildToolEntry(fakeTool('vercel__upsert_env_var'), surface, null);
    expect(entry).toEqual({
      name: 'vercel__upsert_env_var',
      description: 'description of vercel__upsert_env_var',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiredCapabilities: ['vercel:config:write'],
    });
    expect(entry.callable).toBeUndefined();
    expect(entry.missingCapabilities).toBeUndefined();
  });

  test('multi-capability surface (e.g. mint_install_token) formats every slug', () => {
    const surface = [
      cap('github', 'repo', 'access', 'read'),
      cap('github', 'repo', 'code', 'write'),
    ];
    const entry = buildToolEntry(fakeTool('github__mint_install_token'), surface, null);
    expect(entry.requiredCapabilities).toEqual(['github:access:read', 'github:code:write']);
  });
});

describe('buildToolEntry — granted=[…] (live-token path)', () => {
  test('callable=true when granted covers surface (env ignored)', () => {
    const granted = [cap('vercel', 'runtime', 'deployment', 'read', 'prod')];
    const surface = [cap('vercel', 'runtime', 'deployment', 'read')];
    const entry = buildToolEntry(fakeTool('vercel__list_deployments'), surface, granted);
    expect(entry.callable).toBe(true);
    expect(entry.missingCapabilities).toBeUndefined();
  });

  test('callable=false when nothing covers surface, missingCapabilities echoes the surface', () => {
    const granted = [cap('vercel', 'runtime', 'deployment', 'read', 'prod')];
    const surface = [cap('vercel', 'runtime', 'config', 'write')];
    const entry = buildToolEntry(fakeTool('vercel__upsert_env_var'), surface, granted);
    expect(entry.callable).toBe(false);
    expect(entry.missingCapabilities).toEqual(['vercel:config:write']);
  });

  test('multi-capability surface: callable=true if granted covers any one of them', () => {
    // github__mint_install_token surface = [access:read, code:write]. Token has code:write only.
    const granted = [cap('github', 'repo', 'code', 'write', 'main')];
    const surface = [
      cap('github', 'repo', 'access', 'read'),
      cap('github', 'repo', 'code', 'write'),
    ];
    const entry = buildToolEntry(fakeTool('github__mint_install_token'), surface, granted);
    expect(entry.callable).toBe(true);
  });

  test('env defensive: a granted @prod does NOT cover a different env, but callable is env-less', () => {
    // The tools/list filter is env-less by spec — env defensive only applies at
    // tools/call time. So a granted vercel:config:write@preview still makes
    // upsert_env_var "callable" in the catalog (it might still be denied at
    // call time on @prod args, but that's a different layer).
    const granted = [cap('vercel', 'runtime', 'config', 'write', 'preview')];
    const surface = [cap('vercel', 'runtime', 'config', 'write')];
    const entry = buildToolEntry(fakeTool('vercel__upsert_env_var'), surface, granted);
    expect(entry.callable).toBe(true);
  });

  test('empty granted set → every tool callable=false', () => {
    const granted: Capability[] = [];
    const surface = [cap('vercel', 'runtime', 'deployment', 'read')];
    const entry = buildToolEntry(fakeTool('vercel__list_deployments'), surface, granted);
    expect(entry.callable).toBe(false);
    expect(entry.missingCapabilities).toEqual(['vercel:deployment:read']);
  });
});

describe('groupBindings — agent discovery of upstream resource refs', () => {
  const binding = (
    provider: ProviderBinding['provider'],
    resource_ref: string,
    environment: string | null,
    display_name: string | null,
  ): ProviderBinding => ({
    id: `bnd-${provider}-${resource_ref}`,
    project_id: 'prj-1',
    provider,
    resource_ref,
    display_name,
    environment,
    created_at: '2026-06-12T00:00:00Z',
  });

  test('groups by provider slug, keeps every ref', () => {
    const out = groupBindings([
      binding('vercel', 'prj_VERCEL_A', null, 'Web'),
      binding('supabase', 'abcd1234', 'prod', 'Prod DB'),
      binding('supabase', 'efgh5678', 'staging', 'Staging DB'),
    ]);
    expect(out).toEqual({
      vercel: [{ resourceRef: 'prj_VERCEL_A', environment: null, displayName: 'Web' }],
      supabase: [
        { resourceRef: 'abcd1234', environment: 'prod', displayName: 'Prod DB' },
        { resourceRef: 'efgh5678', environment: 'staging', displayName: 'Staging DB' },
      ],
    });
  });

  test('empty input → empty object (no provider keys emitted)', () => {
    expect(groupBindings([])).toEqual({});
  });

  test('normalizes legacy environment=undefined to null', () => {
    const legacy: ProviderBinding = {
      id: 'bnd-legacy',
      project_id: 'prj-1',
      provider: 'github',
      resource_ref: 'acme/app',
      display_name: null,
      created_at: '2026-06-12T00:00:00Z',
    };
    expect(groupBindings([legacy])).toEqual({
      github: [{ resourceRef: 'acme/app', environment: null, displayName: null }],
    });
  });
});

describe('buildProviderCatalog — multi-provider wiring', () => {
  test('mgmt-key path: every tool exposed without callable info', () => {
    const out = buildProviderCatalog([fakeSource()], null);
    expect(out).toHaveLength(1);
    const tools = out[0]!.tools;
    expect(tools.map((t) => t.name)).toEqual([
      'vercel__list_deployments',
      'vercel__upsert_env_var',
    ]);
    for (const t of tools) {
      expect(t.callable).toBeUndefined();
      expect(t.missingCapabilities).toBeUndefined();
    }
  });

  test('live-token path: per-tool callable flag matches granted set', () => {
    // Token has only deployment:read → list_deployments callable, upsert_env_var not.
    const granted = [cap('vercel', 'runtime', 'deployment', 'read', 'prod')];
    const out = buildProviderCatalog([fakeSource()], granted);
    const tools = out[0]!.tools;
    expect(tools[0]).toMatchObject({ name: 'vercel__list_deployments', callable: true });
    expect(tools[1]).toMatchObject({
      name: 'vercel__upsert_env_var',
      callable: false,
      missingCapabilities: ['vercel:config:write'],
    });
  });
});
