import { describe, expect, it } from 'vitest';

import { vercelProject, vercelTeam, vercelTeamAdmin } from '../../../src/providers/vercel/index.js';
import type {
  McpServerFragment,
  OrgResourceAdminKind,
  ResourceKind,
} from '../../../src/resource-kind.js';

/**
 * Spec §12.1 — per-kind unit tests for the Vercel kinds. Mirrors the
 * shape of `github.test.ts`. Each kind is checked against the
 * `ResourceKind` contract: required fields, valid discriminators, no
 * hard-coded credentials, MCP fragment shape (HTTP remote for Vercel),
 * egress allowlist non-emptiness for non-project kinds.
 *
 * Provider operations on `vercel-team-admin.{listChildren,…}` are
 * intentionally Phase-6 stubs — we only verify here that they reject
 * with the `phase-6:` marker, locking the contract shape.
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
    if (spec.description !== undefined) {
      expect(spec.description).toBeTypeOf('string');
    }
  }
}

function assertMcpFragmentShape(frag: McpServerFragment): void {
  // Either a stdio-style fragment (command set) or a remote HTTP one
  // (`type: 'http'` with a `url`).
  const isHttp = frag.type === 'http';
  if (isHttp) {
    expect(typeof frag.url).toBe('string');
    expect(String(frag.url).startsWith('https://')).toBe(true);
  } else {
    expect(frag.command).toBeTypeOf('string');
    expect(String(frag.command).length).toBeGreaterThan(0);
  }
  if (frag.env !== undefined) {
    for (const [k, v] of Object.entries(frag.env)) {
      expect(k).toBeTypeOf('string');
      expect(v).toBeTypeOf('string');
    }
  }
}

describe('vercel-team', () => {
  it('respects the ResourceKind contract', () => {
    expect(vercelTeam.id).toBe('vercel-team');
    expect(vercelTeam.id).toMatch(SLUG);
    expect(vercelTeam.provider).toBe('vercel');
    expect(vercelTeam.kindClass).toBe('org');
    expect(vercelTeam.displayName.length).toBeGreaterThan(0);
    expect(vercelTeam.rotationMethod).toBe('manual');
    assertAccessSchema(vercelTeam);
  });

  it('declares accessSchema = { VERCEL_TOKEN, VERCEL_TEAM_ID }', () => {
    expect(Object.keys(vercelTeam.accessSchema).sort()).toEqual(['VERCEL_TEAM_ID', 'VERCEL_TOKEN']);
    expect(vercelTeam.accessSchema.VERCEL_TOKEN?.required).toBe(true);
    expect(vercelTeam.accessSchema.VERCEL_TEAM_ID?.required).toBe(true);
    expect(vercelTeam.accessSchema.VERCEL_TEAM_ID?.pattern).toMatch(/team_/);
  });

  it('ships markdown setupDocs covering token creation + team id', () => {
    expect(vercelTeam.setupDocs.length).toBeGreaterThan(100);
    expect(vercelTeam.setupDocs).toMatch(/##/);
    expect(vercelTeam.setupDocs.toLowerCase()).toMatch(/team/);
    expect(vercelTeam.setupDocs.toLowerCase()).toMatch(/token/);
    expect(vercelTeam.setupDocs).toMatch(/vercel\.com/);
  });

  it('healthTestCmd embeds the team slug and references $VERCEL_TOKEN', () => {
    const cmd = vercelTeam.healthTestCmd({ teamSlug: 'vauban' }, { VERCEL_TOKEN: 'secret-value' });
    expect(cmd).toMatch(/teams\/vauban/);
    expect(cmd).toMatch(/\$VERCEL_TOKEN/);
    expect(cmd).not.toContain('secret-value');
  });

  it('healthTestCmd rejects malformed metadata', () => {
    expect(() => vercelTeam.healthTestCmd({}, {})).toThrow();
    expect(() => vercelTeam.healthTestCmd({ teamSlug: '' }, {})).toThrow();
  });

  it('mcpFragment exposes the Vercel remote HTTP MCP endpoint', () => {
    const frag = vercelTeam.mcpFragment?.({ teamSlug: 'vauban' });
    expect(frag).not.toBeNull();
    expect(frag).toBeDefined();
    assertMcpFragmentShape(frag!);
    expect(frag!.type).toBe('http');
    expect(frag!.url).toBe('https://mcp.vercel.com/');
  });

  it('egressHosts is non-empty and covers api.vercel.com', () => {
    const hosts = vercelTeam.egressHosts({ teamSlug: 'vauban' });
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).toContain('api.vercel.com');
    expect(hosts).toContain('mcp.vercel.com');
  });
});

describe('vercel-team-admin', () => {
  it('respects the OrgResourceAdminKind contract', () => {
    expect(vercelTeamAdmin.id).toBe('vercel-team-admin');
    expect(vercelTeamAdmin.id).toMatch(SLUG);
    expect(vercelTeamAdmin.provider).toBe('vercel');
    expect(vercelTeamAdmin.kindClass).toBe('org-admin');
    expect(vercelTeamAdmin.rotationMethod).toBe('manual');
    assertAccessSchema(vercelTeamAdmin);
  });

  it('declares manages = [vercel-project]', () => {
    expect(vercelTeamAdmin.manages).toEqual(['vercel-project']);
  });

  it('ships substantial markdown setupDocs (admin scopes)', () => {
    expect(vercelTeamAdmin.setupDocs.length).toBeGreaterThan(100);
    expect(vercelTeamAdmin.setupDocs.toLowerCase()).toMatch(/admin/);
    expect(vercelTeamAdmin.setupDocs.toLowerCase()).toMatch(/owner/);
  });

  it('healthTestCmd embeds the team slug and checks admin role', () => {
    const cmd = vercelTeamAdmin.healthTestCmd({ teamSlug: 'vauban' }, { VERCEL_TOKEN: 't' });
    expect(cmd).toMatch(/teams\/vauban/);
    expect(cmd).toMatch(/\$VERCEL_TOKEN/);
    expect(cmd).toMatch(/role/);
  });

  it('mcpFragment exposes the Vercel remote HTTP MCP endpoint', () => {
    const frag = vercelTeamAdmin.mcpFragment?.({ teamSlug: 'vauban' });
    expect(frag).toBeDefined();
    assertMcpFragmentShape(frag!);
    expect(frag!.type).toBe('http');
    expect(frag!.url).toBe('https://mcp.vercel.com/');
  });

  it('egressHosts covers api.vercel.com and mcp.vercel.com', () => {
    const hosts = vercelTeamAdmin.egressHosts({ teamSlug: 'vauban' });
    expect(hosts).toContain('api.vercel.com');
    expect(hosts).toContain('mcp.vercel.com');
  });

  // Phase 6 lit up listChildren/createChild/destroyChild and made
  // rotateChildAccess a structured fallback — see
  // tests/unit/providers/vercel-admin.test.ts for the mocked-fetch
  // behaviour tests.
  it('provider operations are now Phase 6-live (no longer phase-6 stubs)', () => {
    expect(typeof vercelTeamAdmin.listChildren).toBe('function');
    expect(typeof vercelTeamAdmin.createChild).toBe('function');
    expect(typeof vercelTeamAdmin.destroyChild).toBe('function');
    expect(typeof vercelTeamAdmin.rotateChildAccess).toBe('function');
    void MARKER_PHASE_6;
  });

  it('narrows to OrgResourceAdminKind at the type level', () => {
    const _narrowed: OrgResourceAdminKind = vercelTeamAdmin;
    expect(_narrowed.manages.length).toBeGreaterThan(0);
  });
});

describe('vercel-project', () => {
  it('respects the ProjectResourceKind contract', () => {
    expect(vercelProject.id).toBe('vercel-project');
    expect(vercelProject.id).toMatch(SLUG);
    expect(vercelProject.provider).toBe('vercel');
    expect(vercelProject.kindClass).toBe('project');
    expect(vercelProject.rotationMethod).toBe('admin-mediated');
    assertAccessSchema(vercelProject);
  });

  it('declares the three keys (token + team id + project id)', () => {
    expect(Object.keys(vercelProject.accessSchema).sort()).toEqual([
      'VERCEL_PROJECT_ID',
      'VERCEL_TEAM_ID',
      'VERCEL_TOKEN',
    ]);
    expect(vercelProject.accessSchema.VERCEL_PROJECT_ID?.pattern).toMatch(/prj_/);
  });

  it('ships markdown setupDocs explaining admin-mediated provisioning', () => {
    expect(vercelProject.setupDocs.length).toBeGreaterThan(100);
    expect(vercelProject.setupDocs.toLowerCase()).toMatch(/admin-mediated/);
    expect(vercelProject.setupDocs.toLowerCase()).toMatch(/vercel-team-admin/);
  });

  it('healthTestCmd embeds {teamSlug, projectSlug} from metadata', () => {
    const cmd = vercelProject.healthTestCmd(
      { teamSlug: 'vauban', projectSlug: 'web-app' },
      { VERCEL_TOKEN: 't' },
    );
    expect(cmd).toMatch(/projects\/web-app/);
    expect(cmd).toMatch(/\$VERCEL_TOKEN/);
    expect(cmd).toMatch(/\$VERCEL_TEAM_ID/);
  });

  it('healthTestCmd rejects partial metadata', () => {
    expect(() => vercelProject.healthTestCmd({ teamSlug: 'v' }, {})).toThrow();
    expect(() => vercelProject.healthTestCmd({ projectSlug: 'p' }, {})).toThrow();
  });

  it('does not expose an mcpFragment (Vercel MCP is wired at team level)', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const fn = vercelProject.mcpFragment;
    expect(fn).toBeUndefined();
  });

  it('egressHosts is non-empty', () => {
    const hosts = vercelProject.egressHosts({ teamSlug: 'v', projectSlug: 'p' });
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).toContain('api.vercel.com');
  });
});
