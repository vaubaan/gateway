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
  // `list_deployments` is env-static (no `target` arg) ; `upsert_env_var`
  // resolves env from `args.target` at call time.
  envResolutionOf: (name) => (name === 'vercel__upsert_env_var' ? 'runtime' : 'static'),
});

describe('buildToolEntry — granted=null (mgmt-key path)', () => {
  test('emits requiredCapabilities, no callable / no missingCapabilities', () => {
    const surface = [cap('vercel', 'runtime', 'config', 'write')];
    const entry = buildToolEntry(fakeTool('vercel__upsert_env_var'), surface, 'runtime', null);
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
    const entry = buildToolEntry(fakeTool('github__mint_install_token'), surface, 'static', null);
    expect(entry.requiredCapabilities).toEqual(['github:access:read', 'github:code:write']);
  });
});

describe('buildToolEntry — granted=[…], envResolution="runtime"', () => {
  test('any env-qualified grant on the right 4-tuple makes it callable', () => {
    // upsert_env_var resolves env from args.target at call time. The env
    // defensive filter at tools/call will reject mismatched envs ; the
    // catalog only filters on (provider, plane, level, action).
    const granted = [cap('vercel', 'runtime', 'config', 'write', 'preview')];
    const surface = [cap('vercel', 'runtime', 'config', 'write')];
    const entry = buildToolEntry(fakeTool('vercel__upsert_env_var'), surface, 'runtime', granted);
    expect(entry.callable).toBe(true);
    expect(entry.missingCapabilities).toBeUndefined();
  });

  test('callable=false when no grant matches the 4-tuple at all', () => {
    const granted = [cap('vercel', 'runtime', 'deployment', 'read', 'prod')];
    const surface = [cap('vercel', 'runtime', 'config', 'write')];
    const entry = buildToolEntry(fakeTool('vercel__upsert_env_var'), surface, 'runtime', granted);
    expect(entry.callable).toBe(false);
    expect(entry.missingCapabilities).toEqual(['vercel:config:write']);
  });

  test('multi-capability surface: callable=true if any one matches', () => {
    const granted = [cap('github', 'repo', 'code', 'write', 'main')];
    const surface = [
      cap('github', 'repo', 'access', 'read'),
      cap('github', 'repo', 'code', 'write'),
    ];
    const entry = buildToolEntry(
      fakeTool('github__create_or_update_file'),
      surface,
      'runtime',
      granted,
    );
    expect(entry.callable).toBe(true);
  });
});

describe('buildToolEntry — granted=[…], envResolution="static"', () => {
  // env-static surfaces require an exact 5-tuple match : env-less grant for
  // an env-less requirement. This is the lockstep with the runtime covers()
  // check that was missing pre-fix #1.
  test('env-less surface + env-less grant → callable=true', () => {
    const granted = [cap('vercel', 'runtime', 'deployment', 'read')];
    const surface = [cap('vercel', 'runtime', 'deployment', 'read')];
    const entry = buildToolEntry(fakeTool('vercel__list_deployments'), surface, 'static', granted);
    expect(entry.callable).toBe(true);
  });

  test('env-less surface + env-qualified grant → callable=false (the original bug)', () => {
    // Pre-fix this returned callable=true, then tools/call 403'd. The runtime
    // requires env-less grant for env-less requirement ; the catalog now
    // mirrors that.
    const granted = [cap('vercel', 'runtime', 'deployment', 'read', 'prod')];
    const surface = [cap('vercel', 'runtime', 'deployment', 'read')];
    const entry = buildToolEntry(fakeTool('vercel__list_deployments'), surface, 'static', granted);
    expect(entry.callable).toBe(false);
    expect(entry.missingCapabilities).toEqual(['vercel:deployment:read']);
  });
});

describe('buildToolEntry — granted=[] (empty set)', () => {
  test('every tool callable=false, missingCapabilities echoes the surface', () => {
    const granted: Capability[] = [];
    const surface = [cap('vercel', 'runtime', 'deployment', 'read')];
    const entry = buildToolEntry(fakeTool('vercel__list_deployments'), surface, 'static', granted);
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
    // Token has only deployment:read (env-less) → list_deployments callable
    // (env-static, exact match), upsert_env_var not (wrong 4-tuple).
    const granted = [cap('vercel', 'runtime', 'deployment', 'read')];
    const out = buildProviderCatalog([fakeSource()], granted);
    const tools = out[0]!.tools;
    expect(tools[0]).toMatchObject({ name: 'vercel__list_deployments', callable: true });
    expect(tools[1]).toMatchObject({
      name: 'vercel__upsert_env_var',
      callable: false,
      missingCapabilities: ['vercel:config:write'],
    });
  });

  test('env-qualified grant for env-static surface → callable=false (fix #1)', () => {
    // list_deployments is env-static. A @prod grant must NOT make it callable :
    // runtime would return 403 because covers() requires exact env match.
    const granted = [cap('vercel', 'runtime', 'deployment', 'read', 'prod')];
    const out = buildProviderCatalog([fakeSource()], granted);
    expect(out[0]!.tools[0]).toMatchObject({
      name: 'vercel__list_deployments',
      callable: false,
      missingCapabilities: ['vercel:deployment:read'],
    });
  });

  test('env-qualified grant for env-runtime surface → callable=true', () => {
    // upsert_env_var is env-runtime — a @preview grant is a potential match
    // (the env defensive filter blocks the wrong env at call time).
    const granted = [cap('vercel', 'runtime', 'config', 'write', 'preview')];
    const out = buildProviderCatalog([fakeSource()], granted);
    expect(out[0]!.tools[1]).toMatchObject({
      name: 'vercel__upsert_env_var',
      callable: true,
    });
  });
});
