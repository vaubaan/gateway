import { describe, expect, it } from 'vitest';

import {
  supabaseOrg,
  supabaseOrgAdmin,
  supabaseProject,
} from '../../../src/providers/supabase-cloud/index.js';
import type {
  McpServerFragment,
  OrgResourceAdminKind,
  ResourceKind,
} from '../../../src/resource-kind.js';

/**
 * Spec §12.1 — per-kind unit tests for the Supabase Cloud kinds.
 * Mirrors `github.test.ts` / `vercel.test.ts`. Each kind is checked
 * against the `ResourceKind` contract: required fields, valid
 * discriminators, no hard-coded credentials, MCP fragment shape
 * (stdio via npx for Supabase), egress allowlist non-emptiness for
 * non-project kinds.
 *
 * Provider operations on `supabase-org-admin.{listChildren,…}` are
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
  // Supabase uses the stdio MCP flavour (npx wrapper) — `command` MUST
  // be set. The HTTP-remote flavour (Vercel) omits it.
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
      // No raw Supabase PAT literals in the env block.
      expect(v).not.toMatch(/^sbp_/);
    }
  }
}

describe('supabase-org', () => {
  it('respects the ResourceKind contract', () => {
    expect(supabaseOrg.id).toBe('supabase-org');
    expect(supabaseOrg.id).toMatch(SLUG);
    expect(supabaseOrg.provider).toBe('supabase-cloud');
    expect(supabaseOrg.kindClass).toBe('org');
    expect(supabaseOrg.displayName.length).toBeGreaterThan(0);
    expect(supabaseOrg.rotationMethod).toBe('manual');
    assertAccessSchema(supabaseOrg);
  });

  it('declares accessSchema = { SUPABASE_ACCESS_TOKEN }', () => {
    expect(Object.keys(supabaseOrg.accessSchema)).toEqual(['SUPABASE_ACCESS_TOKEN']);
    expect(supabaseOrg.accessSchema.SUPABASE_ACCESS_TOKEN?.required).toBe(true);
    expect(supabaseOrg.accessSchema.SUPABASE_ACCESS_TOKEN?.pattern).toMatch(/sbp_/);
  });

  it('ships markdown setupDocs covering PAT creation and org slug', () => {
    expect(supabaseOrg.setupDocs.length).toBeGreaterThan(100);
    expect(supabaseOrg.setupDocs).toMatch(/##/);
    expect(supabaseOrg.setupDocs.toLowerCase()).toMatch(/personal access token/);
    expect(supabaseOrg.setupDocs.toLowerCase()).toMatch(/slug/);
    expect(supabaseOrg.setupDocs).toMatch(/supabase\.com/);
  });

  it('healthTestCmd embeds the org slug and references $SUPABASE_ACCESS_TOKEN', () => {
    const cmd = supabaseOrg.healthTestCmd(
      { orgSlug: 'vauban' },
      { SUPABASE_ACCESS_TOKEN: 'secret-value-do-not-log' },
    );
    expect(cmd).toMatch(/vauban/);
    expect(cmd).toMatch(/\$SUPABASE_ACCESS_TOKEN/);
    expect(cmd).toMatch(/api\.supabase\.com/);
    expect(cmd).not.toContain('secret-value-do-not-log');
  });

  it('healthTestCmd rejects malformed metadata', () => {
    expect(() => supabaseOrg.healthTestCmd({}, {})).toThrow();
    expect(() => supabaseOrg.healthTestCmd({ orgSlug: '' }, {})).toThrow();
  });

  it('mcpFragment ships the Supabase MCP npx stdio server', () => {
    const frag = supabaseOrg.mcpFragment?.({ orgSlug: 'vauban' });
    expect(frag).not.toBeNull();
    expect(frag).toBeDefined();
    assertMcpFragmentShape(frag!);
    expect(frag!.command).toBe('npx');
    expect(frag!.args).toBeDefined();
    const argsArr = frag!.args as readonly string[];
    expect(argsArr.some((a) => a.includes('@supabase/mcp-server-supabase'))).toBe(true);
    // The PAT must come from the sealed Access bundle — referenced via
    // the `${KEY}` placeholder, never a literal token.
    expect(argsArr.some((a) => a.includes('${SUPABASE_ACCESS_TOKEN}'))).toBe(true);
    for (const a of argsArr) {
      expect(a).not.toMatch(/^sbp_/);
    }
  });

  it('egressHosts covers api.supabase.com', () => {
    const hosts = supabaseOrg.egressHosts({ orgSlug: 'vauban' });
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).toContain('api.supabase.com');
  });
});

describe('supabase-org-admin', () => {
  it('respects the OrgResourceAdminKind contract', () => {
    expect(supabaseOrgAdmin.id).toBe('supabase-org-admin');
    expect(supabaseOrgAdmin.id).toMatch(SLUG);
    expect(supabaseOrgAdmin.provider).toBe('supabase-cloud');
    expect(supabaseOrgAdmin.kindClass).toBe('org-admin');
    expect(supabaseOrgAdmin.rotationMethod).toBe('manual');
    assertAccessSchema(supabaseOrgAdmin);
  });

  it('declares manages = [supabase-project]', () => {
    expect(supabaseOrgAdmin.manages).toEqual(['supabase-project']);
  });

  it('ships substantial markdown setupDocs (admin scopes)', () => {
    expect(supabaseOrgAdmin.setupDocs.length).toBeGreaterThan(100);
    expect(supabaseOrgAdmin.setupDocs.toLowerCase()).toMatch(/owner/);
    expect(supabaseOrgAdmin.setupDocs.toLowerCase()).toMatch(/administrator/);
    expect(supabaseOrgAdmin.setupDocs.toLowerCase()).toMatch(/admin-mediated|service_role/);
  });

  it('healthTestCmd embeds the org slug and checks admin role', () => {
    const cmd = supabaseOrgAdmin.healthTestCmd(
      { orgSlug: 'vauban' },
      { SUPABASE_ACCESS_TOKEN: 't' },
    );
    expect(cmd).toMatch(/vauban/);
    expect(cmd).toMatch(/\$SUPABASE_ACCESS_TOKEN/);
    expect(cmd).toMatch(/Owner|Administrator/);
  });

  it('mcpFragment ships the Supabase MCP npx stdio server', () => {
    const frag = supabaseOrgAdmin.mcpFragment?.({ orgSlug: 'vauban' });
    expect(frag).toBeDefined();
    assertMcpFragmentShape(frag!);
    expect(frag!.command).toBe('npx');
  });

  it('egressHosts covers api.supabase.com', () => {
    const hosts = supabaseOrgAdmin.egressHosts({ orgSlug: 'vauban' });
    expect(hosts).toContain('api.supabase.com');
  });

  // Phase 6 lit up listChildren/createChild/destroyChild and made
  // rotateChildAccess dispatch per key — see
  // tests/unit/providers/supabase-admin.test.ts for the mocked-fetch
  // behaviour tests.
  it('provider operations are now Phase 6-live (no longer phase-6 stubs)', () => {
    expect(typeof supabaseOrgAdmin.listChildren).toBe('function');
    expect(typeof supabaseOrgAdmin.createChild).toBe('function');
    expect(typeof supabaseOrgAdmin.destroyChild).toBe('function');
    expect(typeof supabaseOrgAdmin.rotateChildAccess).toBe('function');
    void MARKER_PHASE_6;
  });

  it('narrows to OrgResourceAdminKind at the type level', () => {
    const _narrowed: OrgResourceAdminKind = supabaseOrgAdmin;
    expect(_narrowed.manages.length).toBeGreaterThan(0);
  });
});

describe('supabase-project', () => {
  it('respects the ProjectResourceKind contract', () => {
    expect(supabaseProject.id).toBe('supabase-project');
    expect(supabaseProject.id).toMatch(SLUG);
    expect(supabaseProject.provider).toBe('supabase-cloud');
    expect(supabaseProject.kindClass).toBe('project');
    expect(supabaseProject.rotationMethod).toBe('admin-mediated');
    assertAccessSchema(supabaseProject);
  });

  it('declares the five keys (URL + anon + service_role + DB password + ref)', () => {
    expect(Object.keys(supabaseProject.accessSchema).sort()).toEqual([
      'SUPABASE_ANON_KEY',
      'SUPABASE_DB_PASSWORD',
      'SUPABASE_PROJECT_REF',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
    ]);
    expect(supabaseProject.accessSchema.SUPABASE_URL?.pattern).toMatch(/supabase\\.co/);
    expect(supabaseProject.accessSchema.SUPABASE_PROJECT_REF?.pattern).toMatch(/a-z/);
    expect(supabaseProject.accessSchema.SUPABASE_ANON_KEY?.pattern).toMatch(/eyJ/);
    expect(supabaseProject.accessSchema.SUPABASE_SERVICE_ROLE_KEY?.pattern).toMatch(/eyJ/);
  });

  it('ships markdown setupDocs explaining admin-mediated provisioning', () => {
    expect(supabaseProject.setupDocs.length).toBeGreaterThan(100);
    expect(supabaseProject.setupDocs.toLowerCase()).toMatch(/admin-mediated/);
    expect(supabaseProject.setupDocs.toLowerCase()).toMatch(/supabase-org-admin/);
    expect(supabaseProject.setupDocs.toLowerCase()).toMatch(/service_role/);
  });

  it('healthTestCmd uses $SUPABASE_URL and $SUPABASE_ANON_KEY', () => {
    const cmd = supabaseProject.healthTestCmd(
      { orgSlug: 'vauban', projectRef: 'abcdefghijklmnopqrst' },
      { SUPABASE_ANON_KEY: 'eyJ.dummy.token' },
    );
    expect(cmd).toMatch(/\$SUPABASE_URL/);
    expect(cmd).toMatch(/\$SUPABASE_ANON_KEY/);
    expect(cmd).not.toMatch(/\$SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('healthTestCmd rejects partial metadata', () => {
    expect(() => supabaseProject.healthTestCmd({ orgSlug: 'v' }, {})).toThrow();
    expect(() => supabaseProject.healthTestCmd({ projectRef: 'p' }, {})).toThrow();
    expect(() => supabaseProject.healthTestCmd({}, {})).toThrow();
  });

  it('does not expose an mcpFragment (Supabase MCP is account-PAT, not project-scoped)', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const fn = supabaseProject.mcpFragment;
    expect(fn).toBeUndefined();
  });

  it('egressHosts is non-empty and includes the project hostname', () => {
    const hosts = supabaseProject.egressHosts({
      orgSlug: 'vauban',
      projectRef: 'abcdefghijklmnopqrst',
    });
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).toContain('api.supabase.com');
    expect(hosts.some((h) => h.includes('abcdefghijklmnopqrst.supabase.co'))).toBe(true);
  });
});
