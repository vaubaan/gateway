/**
 * Unit tests for `composeMcpConfig` — spec §6.6.
 *
 * We don't reach into `@crm/catalog`: the test injects its own
 * `findKind` callback so the composer surface is exercised without a
 * cross-package import.
 */

import { describe, it, expect } from 'vitest';

import {
  composeMcpConfig,
  type ComposableKind,
  type ComposableResource,
  type ComposeEnv,
} from '../../../src/mcp/index.js';

interface KindFixture extends ComposableKind {
  readonly id: string;
}

function makeFixtureEnv(kinds: ReadonlyArray<KindFixture>): ComposeEnv {
  return {
    findKind(id) {
      return kinds.find((k) => k.id === id);
    },
  };
}

const githubOrgKind: KindFixture = {
  id: 'github-org',
  accessSchema: { GITHUB_TOKEN: {} },
  mcpFragment(
    metadata,
  ): { command: string; args: readonly string[]; env: Record<string, string> } | null {
    const m = metadata as { org?: unknown } | null;
    if (m === null || typeof m !== 'object' || typeof m.org !== 'string') return null;
    return {
      command: 'docker',
      args: [
        'run',
        '-i',
        '--rm',
        '-e',
        'GITHUB_PERSONAL_ACCESS_TOKEN',
        'ghcr.io/github/github-mcp-server',
      ],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
    };
  },
};

const vercelTeamKind: KindFixture = {
  id: 'vercel-team',
  accessSchema: { VERCEL_TOKEN: {}, VERCEL_TEAM_ID: {} },
  mcpFragment(_metadata): { type: string; url: string } {
    return { type: 'http', url: 'https://mcp.vercel.com/' };
  },
};

const supabaseOrgKind: KindFixture = {
  id: 'supabase-org',
  accessSchema: { SUPABASE_ACCESS_TOKEN: {} },
  mcpFragment(_metadata): { command: string; args: readonly string[] } {
    return {
      command: 'npx',
      args: [
        '-y',
        '@supabase/mcp-server-supabase@latest',
        '--access-token',
        '${SUPABASE_ACCESS_TOKEN}',
      ],
    };
  },
};

const githubRepoKind: KindFixture = {
  id: 'github-repo',
  accessSchema: { GITHUB_TOKEN: {} },
  // No mcpFragment property at all — a kind without MCP support must be ignored.
};

function res(
  id: string,
  kind: string,
  name: string,
  metadata: Record<string, unknown>,
  variant: string | null = null,
): ComposableResource {
  return { id, kind, name, variant, provider_metadata: metadata };
}

describe('composeMcpConfig', () => {
  const env = makeFixtureEnv([githubOrgKind, vercelTeamKind, supabaseOrgKind, githubRepoKind]);

  it('composes 3 resources (github/vercel/supabase) into 3 mcpServers', () => {
    const out = composeMcpConfig({
      resources: [
        res('r-gh', 'github-org', 'acme-gh', { org: 'acme' }),
        res('r-v', 'vercel-team', 'acme-vercel', { teamSlug: 'acme' }),
        res('r-sb', 'supabase-org', 'acme-supabase', { orgSlug: 'acme' }),
      ],
      env,
    });

    expect(Object.keys(out.mcpJson.mcpServers)).toHaveLength(3);
    expect(out.mcpJson.mcpServers['acme-gh']).toMatchObject({ command: 'docker' });
    expect(out.mcpJson.mcpServers['acme-vercel']).toMatchObject({
      type: 'http',
      url: 'https://mcp.vercel.com/',
    });
    expect(out.mcpJson.mcpServers['acme-supabase']).toMatchObject({ command: 'npx' });

    // Each resource contributes one placeholder; vercel-team uses no
    // placeholder (OAuth). Manifest entries are unique per (rid, key).
    const keys = out.envManifest.keys;
    expect(keys.map((k) => `${k.source_resource_id}:${k.key}`)).toEqual(
      expect.arrayContaining(['r-gh:GITHUB_TOKEN', 'r-sb:SUPABASE_ACCESS_TOKEN']),
    );
    // Vercel HTTP MCP carries no env placeholder.
    expect(keys.some((k) => k.source_resource_id === 'r-v')).toBe(false);
  });

  it('ignores kinds without mcpFragment (e.g. github-repo)', () => {
    const out = composeMcpConfig({
      resources: [
        res('r-repo', 'github-repo', 'acme-frontend', { org: 'acme', repo: 'frontend' }),
        res('r-gh', 'github-org', 'acme-gh', { org: 'acme' }),
      ],
      env,
    });
    expect(Object.keys(out.mcpJson.mcpServers)).toEqual(['acme-gh']);
  });

  it('ignores kinds with mcpFragment returning null (defensive metadata guard)', () => {
    const out = composeMcpConfig({
      resources: [
        // Malformed metadata — kind.mcpFragment returns null.
        res('r-bad', 'github-org', 'bad-gh', {
          /* missing org */
        }),
        res('r-gh', 'github-org', 'acme-gh', { org: 'acme' }),
      ],
      env,
    });
    expect(Object.keys(out.mcpJson.mcpServers)).toEqual(['acme-gh']);
  });

  it('ignores kinds that throw on malformed metadata (treated as no fragment)', () => {
    const throwingKind: KindFixture = {
      id: 'throwing-kind',
      accessSchema: {},
      mcpFragment(_metadata) {
        throw new Error('invalid metadata');
      },
    };
    const localEnv = makeFixtureEnv([throwingKind, githubOrgKind]);
    const out = composeMcpConfig({
      resources: [
        res('r-throws', 'throwing-kind', 'throws-name', {}),
        res('r-gh', 'github-org', 'acme-gh', { org: 'acme' }),
      ],
      env: localEnv,
    });
    expect(Object.keys(out.mcpJson.mcpServers)).toEqual(['acme-gh']);
  });

  it('is deterministic and byte-equivalent for the same input order', () => {
    const input = {
      resources: [
        res('r-gh', 'github-org', 'acme-gh', { org: 'acme' }),
        res('r-sb', 'supabase-org', 'acme-supabase', { orgSlug: 'acme' }),
      ],
      env,
    };
    const a = composeMcpConfig(input);
    const b = composeMcpConfig(input);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('preserves input order in the mcpServers keys (stable iteration)', () => {
    const a = composeMcpConfig({
      resources: [
        res('r-1', 'github-org', 'first', { org: 'first' }),
        res('r-2', 'supabase-org', 'second', { orgSlug: 'second' }),
      ],
      env,
    });
    const b = composeMcpConfig({
      resources: [
        res('r-2', 'supabase-org', 'second', { orgSlug: 'second' }),
        res('r-1', 'github-org', 'first', { org: 'first' }),
      ],
      env,
    });
    expect(Object.keys(a.mcpJson.mcpServers)).toEqual(['first', 'second']);
    expect(Object.keys(b.mcpJson.mcpServers)).toEqual(['second', 'first']);
  });

  it('disambiguates collisions on resource.name by suffixing with resource id', () => {
    const out = composeMcpConfig({
      resources: [
        res('r-gh-1', 'github-org', 'acme', { org: 'acme' }),
        res('r-gh-2', 'github-org', 'acme', { org: 'acme-staging' }),
      ],
      env,
    });
    const keys = Object.keys(out.mcpJson.mcpServers);
    expect(keys).toContain('acme');
    expect(keys).toContain('acme-r-gh-2');
  });

  it('skips resources whose kind is unknown', () => {
    const out = composeMcpConfig({
      resources: [
        res('r-x', 'made-up-kind', 'ghost', { foo: 1 }),
        res('r-gh', 'github-org', 'acme-gh', { org: 'acme' }),
      ],
      env,
    });
    expect(Object.keys(out.mcpJson.mcpServers)).toEqual(['acme-gh']);
  });

  it('returns an empty snapshot when no resource has an mcpFragment', () => {
    const out = composeMcpConfig({
      resources: [
        res('r-repo-1', 'github-repo', 'a', { org: 'a', repo: 'b' }),
        res('r-repo-2', 'github-repo', 'c', { org: 'c', repo: 'd' }),
      ],
      env,
    });
    expect(out.mcpJson.mcpServers).toEqual({});
    expect(out.envManifest.keys).toEqual([]);
  });

  it('dedupes manifest entries when the same key appears twice in args+env', () => {
    const dupKind: KindFixture = {
      id: 'dup-kind',
      accessSchema: { KEY_X: {} },
      mcpFragment() {
        return {
          command: 'echo',
          args: ['--token', '${KEY_X}'],
          env: { KEY_X: '${KEY_X}' },
        };
      },
    };
    const out = composeMcpConfig({
      resources: [res('r-dup', 'dup-kind', 'dup', {})],
      env: makeFixtureEnv([dupKind]),
    });
    expect(out.envManifest.keys).toEqual([
      { key: 'KEY_X', source_resource_id: 'r-dup', source_kind: 'dup-kind' },
    ]);
  });
});
