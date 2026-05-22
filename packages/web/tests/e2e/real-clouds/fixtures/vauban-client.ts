/**
 * Vauban CRM HTTP client for E2E tests.
 *
 * Wraps the REST surface under `/api/crm/v1/*`. Two auth modes:
 *
 *   1. Admin (service-role bypass) — only the bootstrap helpers
 *      (`createTestUser`, `deleteTestUser`) use this. They hit
 *      Supabase Auth's admin API directly.
 *
 *   2. User session (cookies) — every other call uses the same
 *      cookies the Next.js app sets after `signInWithPassword`.
 *      Spec §3.3, §8 : RLS must be honored end-to-end.
 *
 * The browser-side E2E (Playwright `page.request.*`) handles cookie
 * propagation automatically when navigating + form-filling the
 * sign-in page. For the few helpers that operate outside a browser
 * context (sweeper setup, harness self-test), this module exposes
 * a node-side `fetch`-with-cookie-jar variant.
 *
 * ZK invariant : we never log or expose any sealed_blob content.
 * Sealed blobs travel as opaque base64 strings.
 */

import { createClient } from '@supabase/supabase-js';

import { loadE2EEnv } from './env';

type SupabaseAdminClient = ReturnType<typeof createClient>;

interface TestUserCreds {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
}

/**
 * Generates a unique deterministic email for an E2E test user.
 * The `+tag` (RFC 5233) keeps a single mailbox so the operator can
 * sweep them via the auth admin API filter by prefix.
 */
function makeTestUserEmail(base: string, runUuid: string, suffix: string): string {
  const [local, domain] = base.split('@');
  if (local === undefined || domain === undefined) {
    throw new Error(`ORG_EMAIL invalid: ${base}`);
  }
  return `${local}+e2e-${runUuid}-${suffix}@${domain}`;
}

function makeTestPassword(seed: string): string {
  // Strong enough to pass Supabase's default password policy + cheap to type.
  return `e2e-${seed}-aA1!cloudResource`;
}

interface AdminCreateUserResult {
  readonly user: { id: string; email?: string };
}

export class VaubanAdminClient {
  private readonly sb: SupabaseAdminClient;
  constructor(url: string, serviceRoleKey: string) {
    this.sb = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Create a confirmed Supabase Auth user. The user is immediately
   * usable for `signInWithPassword` — no email verification needed.
   */
  async createTestUser(input: { runUuid: string; suffix: string }): Promise<TestUserCreds> {
    const env = loadE2EEnv();
    const email = makeTestUserEmail(env.orgEmail, input.runUuid, input.suffix);
    const password = makeTestPassword(input.runUuid);
    const res = await this.sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { vauban_e2e: true, run_uuid: input.runUuid },
    });
    if (res.error !== null) {
      throw new Error(`createTestUser failed: ${res.error.message}`);
    }
    const userRaw = (res.data as AdminCreateUserResult).user;
    return { email, password, userId: userRaw.id };
  }

  async deleteTestUser(userId: string): Promise<void> {
    const res = await this.sb.auth.admin.deleteUser(userId);
    if (res.error !== null && !/not found/i.test(res.error.message)) {
      throw new Error(`deleteTestUser failed: ${res.error.message}`);
    }
  }

  /**
   * Hard-delete an organization + its members (cascade FK takes
   * care of the rest). Used by afterAll cleanup when no scenario
   * has destroyed the org through the API.
   */
  async deleteOrg(orgId: string): Promise<void> {
    // The orgs row + cascades : resources, secret_managers, mcp_configs,
    // audit_log (FK on_delete=cascade). RLS would block us; we go
    // through service-role on purpose.
    const sbAny = this.sb as unknown as {
      from(t: string): {
        delete(): { eq(c: string, v: string): Promise<{ error: unknown }> };
      };
    };
    const res = await sbAny.from('organizations').delete().eq('id', orgId);
    const err = (res as { error?: { message?: string } }).error;
    if (err !== undefined && err !== null && err.message !== undefined) {
      throw new Error(`deleteOrg(${orgId}) failed: ${err.message}`);
    }
  }

  /**
   * List E2E auth users (`+e2e-…` pattern). Used by sweeper.
   * Note: Supabase admin API paginates at 50 by default.
   */
  async listE2EUsers(): Promise<readonly { id: string; email: string; createdAt: string }[]> {
    const out: { id: string; email: string; createdAt: string }[] = [];
    let page = 1;
    for (let i = 0; i < 20; i++) {
      const res = await this.sb.auth.admin.listUsers({ page, perPage: 100 });
      if (res.error !== null) break;
      const users = (res.data as { users?: { id: string; email?: string; created_at: string }[] })
        .users;
      if (users === undefined || users.length === 0) break;
      for (const u of users) {
        if (u.email !== undefined && /\+e2e-/.test(u.email)) {
          out.push({ id: u.id, email: u.email, createdAt: u.created_at });
        }
      }
      if (users.length < 100) break;
      page += 1;
    }
    return out;
  }

  /**
   * Insert a `projects` row via service-role. No public REST endpoint
   * in v1 — onboarding flow creates the default project implicitly.
   * Returns the new project id.
   */
  async createProject(input: {
    organizationId: string;
    slug: string;
    name: string;
  }): Promise<{ id: string; slug: string }> {
    const sbAny = this.sb as unknown as {
      from(t: string): {
        insert(row: Record<string, unknown>): {
          select(c: string): {
            single(): Promise<{
              data: { id: string; slug: string } | null;
              error: { message?: string } | null;
            }>;
          };
        };
      };
    };
    const res = await sbAny
      .from('projects')
      .insert({
        organization_id: input.organizationId,
        slug: input.slug,
        name: input.name,
      })
      .select('id, slug')
      .single();
    if (res.error !== null) {
      throw new Error(`createProject failed: ${res.error.message ?? 'unknown'}`);
    }
    if (res.data === null) throw new Error('createProject returned no row');
    return res.data;
  }

  /**
   * Add an additional member (admin or member role) to an org via
   * service-role. Bypasses RLS (org admins normally cannot insert
   * other admins through PostgREST). Used by RBAC + re-seal scenarios.
   */
  async addOrgMember(input: {
    organizationId: string;
    userId: string;
    role: 'admin' | 'member';
  }): Promise<void> {
    const sbAny = this.sb as unknown as {
      from(t: string): {
        insert(row: Record<string, unknown>): Promise<{ error: { message?: string } | null }>;
      };
    };
    const res = await sbAny.from('org_members').insert({
      organization_id: input.organizationId,
      user_id: input.userId,
      role: input.role,
    });
    if (res.error !== null) {
      throw new Error(`addOrgMember failed: ${res.error.message ?? 'unknown'}`);
    }
  }

  /**
   * Direct DB access for trigger assertions (e.g. recipients_stale).
   * Returns the raw row or `null`.
   */
  async selectResourceAccess(input: {
    resourceId: string;
    key: string;
  }): Promise<{ recipients_stale: boolean; sealed_blob: string | null } | null> {
    const sbAny = this.sb as unknown as {
      from(t: string): {
        select(c: string): {
          eq(
            c: string,
            v: string,
          ): {
            eq(
              c: string,
              v: string,
            ): {
              maybeSingle(): Promise<{
                data: { recipients_stale: boolean; sealed_blob: string | null } | null;
                error: { message?: string } | null;
              }>;
            };
          };
        };
      };
    };
    const res = await sbAny
      .from('resource_access')
      .select('recipients_stale, sealed_blob')
      .eq('resource_id', input.resourceId)
      .eq('key', input.key)
      .maybeSingle();
    if (res.error !== null) {
      throw new Error(`selectResourceAccess failed: ${res.error.message ?? 'unknown'}`);
    }
    return res.data;
  }
}

export function makeAdminClient(): VaubanAdminClient {
  const env = loadE2EEnv();
  return new VaubanAdminClient(env.supabaseUrl, env.supabaseServiceRoleKey);
}

export { makeTestUserEmail, makeTestPassword };
export type { TestUserCreds };
