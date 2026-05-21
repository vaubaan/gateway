/**
 * Supabase Management API client for E2E tests. Spec §12.3.
 *
 * Endpoints (https://api.supabase.com/api/v1):
 *  - GET    /organizations/:slug/projects   → list
 *  - POST   /projects                       → create
 *  - DELETE /projects/:ref                   → delete
 *
 * Notes:
 *  - Token: `SUPABASE_TOKEN` (sbp_…) — user-wide. Spec calls this out
 *    in `.env`; in E2E we use the dedicated test-account token.
 *  - Provisioning a Supabase project is *slow* (1-3 min). E2E flows
 *    that exercise scenario 3 (rotate admin-mediated for
 *    `SUPABASE_DB_PASSWORD`) account for this via long Playwright
 *    timeouts.
 *  - DB password reset uses
 *    `PATCH /projects/:ref/config/database`. The new password is
 *    returned in clear in the response body — that's how the
 *    Vauban admin client confirms the rotation worked.
 */

import { E2E_RESOURCE_PREFIX, isE2EResourceName } from '../naming';

const SB_MGMT_API = 'https://api.supabase.com/v1';

export interface SupabaseProject {
  readonly id: string;
  readonly name: string;
  readonly organization_id: string;
  readonly region: string;
  readonly created_at: string;
  readonly status?: string;
}

export class SupabaseMgmtClient {
  constructor(
    private readonly token: string,
    private readonly orgSlug: string,
  ) {}

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T | null }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    let bodyStr: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }
    const res = await fetch(`${SB_MGMT_API}${path}`, { method, headers, body: bodyStr });
    if (res.status === 204) return { status: 204, body: null };
    const txt = await res.text();
    if (txt === '') return { status: res.status, body: null };
    return { status: res.status, body: JSON.parse(txt) as T };
  }

  async listProjects(): Promise<SupabaseProject[]> {
    const { status, body } = await this.req<SupabaseProject[]>('GET', '/projects');
    if (status !== 200 || !body) {
      throw new Error(`Supabase listProjects failed: ${status}`);
    }
    return body;
  }

  async createProject(input: {
    name: string;
    region: string;
    dbPass: string;
    plan?: 'free';
  }): Promise<SupabaseProject> {
    const { status, body } = await this.req<SupabaseProject>('POST', '/projects', {
      name: input.name,
      organization_id: this.orgSlug,
      region: input.region,
      db_pass: input.dbPass,
      plan: input.plan ?? 'free',
    });
    if (status !== 200 && status !== 201) {
      throw new Error(`Supabase createProject(${input.name}) failed: ${status}`);
    }
    if (!body) throw new Error(`Supabase createProject(${input.name}) returned no body`);
    return body;
  }

  async deleteProject(ref: string): Promise<void> {
    const { status } = await this.req('DELETE', `/projects/${ref}`);
    if (status !== 200 && status !== 204 && status !== 404) {
      throw new Error(`Supabase deleteProject(${ref}) failed: ${status}`);
    }
  }

  async listE2EProjects(): Promise<SupabaseProject[]> {
    const all = await this.listProjects();
    return all.filter((p) => p.organization_id === this.orgSlug && isE2EResourceName(p.name));
  }

  static readonly prefix = E2E_RESOURCE_PREFIX;
}
