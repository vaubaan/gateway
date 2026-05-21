import { describe, expect, it } from 'vitest';

import { githubOrg, githubOrgAdmin, githubRepo } from '../../../src/providers/github/index.js';
import type {
  McpServerFragment,
  OrgResourceAdminKind,
  ResourceKind,
} from '../../../src/resource-kind.js';

/**
 * Spec §12.1 — per-kind unit tests. Each kind is checked against the
 * `ResourceKind` contract: required fields, valid discriminators, no
 * hard-coded credentials, MCP fragment shape, egress allowlist
 * non-emptiness for non-project kinds.
 *
 * `github-org-admin.{listChildren,createChild,destroyChild,
 * rotateChildAccess}` are intentionally Phase-6 stubs — we only verify
 * here that they throw the `phase-6` marker error, so the contract
 * shape is locked in but the call sites fail loudly.
 */

const SLUG = /^[a-z][a-z0-9-]*$/;
const MARKER_PHASE_6 = /^phase-6:/;

function assertAccessSchema(kind: ResourceKind): void {
  expect(Object.keys(kind.accessSchema).length).toBeGreaterThan(0);
  for (const [key, spec] of Object.entries(kind.accessSchema)) {
    expect(key, `${kind.id}.accessSchema key`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(spec.label).toBeTypeOf('string');
    expect(spec.label.length).toBeGreaterThan(0);
    expect(spec.required).toBeTypeOf('boolean');
    // No cleartext credential snippets must leak through (label /
    // description) — only schema names, regex, and human-readable copy.
    expect(spec.label).not.toMatch(/github_pat_[A-Za-z0-9_]{8}/);
    if (spec.description !== undefined) {
      expect(spec.description).toBeTypeOf('string');
    }
  }
}

function assertMcpFragmentShape(frag: McpServerFragment): void {
  // GitHub kinds use the stdio MCP flavour, so `command` MUST be set.
  // (The HTTP-remote flavour, used by e.g. Vercel, omits it — `command`
  // is therefore optional on the shared `McpServerFragment` interface.)
  expect(frag.command).toBeTypeOf('string');
  expect(frag.command).toBeDefined();
  expect((frag.command as string).length).toBeGreaterThan(0);
  if (frag.args !== undefined) {
    expect(Array.isArray(frag.args)).toBe(true);
    for (const a of frag.args) expect(a).toBeTypeOf('string');
  }
  if (frag.env !== undefined) {
    for (const [k, v] of Object.entries(frag.env)) {
      expect(k).toBeTypeOf('string');
      expect(v).toBeTypeOf('string');
      // The env value must reference an Access key (`${KEY}`) or a
      // constant; no raw GitHub token literals.
      expect(v).not.toMatch(/^github_pat_/);
    }
  }
}

describe('github-org', () => {
  it('respects the ResourceKind contract', () => {
    expect(githubOrg.id).toBe('github-org');
    expect(githubOrg.id).toMatch(SLUG);
    expect(githubOrg.provider).toBe('github');
    expect(githubOrg.kindClass).toBe('org');
    expect(githubOrg.displayName.length).toBeGreaterThan(0);
    expect(githubOrg.rotationMethod).toBe('manual');
    assertAccessSchema(githubOrg);
  });

  it('declares accessSchema = { GITHUB_TOKEN } with a fine-grained PAT pattern', () => {
    expect(Object.keys(githubOrg.accessSchema)).toEqual(['GITHUB_TOKEN']);
    expect(githubOrg.accessSchema.GITHUB_TOKEN?.required).toBe(true);
    expect(githubOrg.accessSchema.GITHUB_TOKEN?.pattern).toMatch(/github_pat_/);
  });

  it('ships markdown setupDocs detailing the PAT generation flow', () => {
    expect(githubOrg.setupDocs.length).toBeGreaterThan(100);
    expect(githubOrg.setupDocs).toMatch(/##/);
    expect(githubOrg.setupDocs.toLowerCase()).toMatch(/fine-grained/);
    expect(githubOrg.setupDocs.toLowerCase()).toMatch(/read-only/);
  });

  it('healthTestCmd embeds the org slug from metadata, never the token', () => {
    const cmd = githubOrg.healthTestCmd({ org: 'vauban' }, { GITHUB_TOKEN: 'secret-value' });
    expect(cmd).toMatch(/orgs\/vauban/);
    expect(cmd).toMatch(/\$GITHUB_TOKEN/);
    expect(cmd).not.toContain('secret-value');
  });

  it('healthTestCmd rejects malformed metadata', () => {
    expect(() => githubOrg.healthTestCmd({}, {})).toThrow();
    expect(() => githubOrg.healthTestCmd({ org: '' }, {})).toThrow();
  });

  it('mcpFragment matches the ghcr.io/github/github-mcp-server image shape', () => {
    const frag = githubOrg.mcpFragment?.({ org: 'vauban' });
    expect(frag).not.toBeNull();
    expect(frag).toBeDefined();
    assertMcpFragmentShape(frag!);
    expect(frag!.command).toBe('docker');
    expect(frag!.args).toContain('ghcr.io/github/github-mcp-server');
    expect(frag!.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('${GITHUB_TOKEN}');
  });

  it('mcpFragment returns null on invalid metadata', () => {
    expect(githubOrg.mcpFragment?.({})).toBeNull();
  });

  it('egressHosts is non-empty and covers api.github.com', () => {
    const hosts = githubOrg.egressHosts({ org: 'vauban' });
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).toContain('api.github.com');
  });
});

describe('github-org-admin', () => {
  it('respects the OrgResourceAdminKind contract', () => {
    expect(githubOrgAdmin.id).toBe('github-org-admin');
    expect(githubOrgAdmin.id).toMatch(SLUG);
    expect(githubOrgAdmin.provider).toBe('github');
    expect(githubOrgAdmin.kindClass).toBe('org-admin');
    expect(githubOrgAdmin.rotationMethod).toBe('manual');
    assertAccessSchema(githubOrgAdmin);
  });

  it('declares manages = [github-repo]', () => {
    expect(githubOrgAdmin.manages).toEqual(['github-repo']);
  });

  it('ships substantial markdown setupDocs (admin scopes)', () => {
    expect(githubOrgAdmin.setupDocs.length).toBeGreaterThan(100);
    expect(githubOrgAdmin.setupDocs.toLowerCase()).toMatch(/administration/);
    expect(githubOrgAdmin.setupDocs.toLowerCase()).toMatch(/read and write/);
  });

  it('healthTestCmd embeds the org slug and references $GITHUB_TOKEN', () => {
    const cmd = githubOrgAdmin.healthTestCmd({ org: 'vauban' }, { GITHUB_TOKEN: 't' });
    expect(cmd).toMatch(/orgs\/vauban/);
    expect(cmd).toMatch(/\$GITHUB_TOKEN/);
  });

  it('mcpFragment exposes the github MCP server', () => {
    const frag = githubOrgAdmin.mcpFragment?.({ org: 'vauban' });
    expect(frag).toBeDefined();
    assertMcpFragmentShape(frag!);
    expect(frag!.args).toContain('ghcr.io/github/github-mcp-server');
  });

  it('egressHosts covers api.github.com and ghcr.io', () => {
    const hosts = githubOrgAdmin.egressHosts({ org: 'vauban' });
    expect(hosts).toContain('api.github.com');
    expect(hosts).toContain('ghcr.io');
  });

  it('provider operations are phase-6 stubs that throw a stable marker', async () => {
    const access: Readonly<Record<string, string>> = { GITHUB_TOKEN: 't' };
    await expect(githubOrgAdmin.listChildren(access)).rejects.toThrow(MARKER_PHASE_6);
    await expect(githubOrgAdmin.createChild(access, {})).rejects.toThrow(MARKER_PHASE_6);
    await expect(githubOrgAdmin.destroyChild(access, 'ref')).rejects.toThrow(MARKER_PHASE_6);
    await expect(githubOrgAdmin.rotateChildAccess(access, 'ref', 'GITHUB_TOKEN')).rejects.toThrow(
      MARKER_PHASE_6,
    );
  });

  it('narrows to OrgResourceAdminKind at the type level', () => {
    // Compile-time assertion via assignment.
    const _narrowed: OrgResourceAdminKind = githubOrgAdmin;
    expect(_narrowed.manages.length).toBeGreaterThan(0);
  });
});

describe('github-repo', () => {
  it('respects the ProjectResourceKind contract', () => {
    expect(githubRepo.id).toBe('github-repo');
    expect(githubRepo.id).toMatch(SLUG);
    expect(githubRepo.provider).toBe('github');
    expect(githubRepo.kindClass).toBe('project');
    expect(githubRepo.rotationMethod).toBe('admin-mediated');
    assertAccessSchema(githubRepo);
  });

  it('ships markdown setupDocs explaining admin-mediated provisioning', () => {
    expect(githubRepo.setupDocs.length).toBeGreaterThan(100);
    expect(githubRepo.setupDocs.toLowerCase()).toMatch(/admin-mediated/);
    expect(githubRepo.setupDocs.toLowerCase()).toMatch(/github-org-admin/);
  });

  it('healthTestCmd embeds {org, repo} from metadata', () => {
    const cmd = githubRepo.healthTestCmd(
      { org: 'vauban', repo: 'cloud-resource-manager' },
      { GITHUB_TOKEN: 't' },
    );
    expect(cmd).toMatch(/repos\/vauban\/cloud-resource-manager/);
    expect(cmd).toMatch(/\$GITHUB_TOKEN/);
  });

  it('healthTestCmd rejects partial metadata', () => {
    expect(() => githubRepo.healthTestCmd({ org: 'vauban' }, {})).toThrow();
    expect(() => githubRepo.healthTestCmd({ repo: 'r' }, {})).toThrow();
  });

  it('does not expose an mcpFragment (single repo is not a useful MCP root)', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const fn = githubRepo.mcpFragment;
    expect(fn).toBeUndefined();
  });

  it('egressHosts is non-empty', () => {
    const hosts = githubRepo.egressHosts({ org: 'v', repo: 'r' });
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).toContain('api.github.com');
  });
});
