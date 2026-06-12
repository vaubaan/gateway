import { describe, expect, test } from 'vitest';
import type { Capability, McpToolDeclaration } from '@vaubaan/shared';
import { buildProviderCatalog, buildToolEntry, type ProviderSource } from './catalog.ts';

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
