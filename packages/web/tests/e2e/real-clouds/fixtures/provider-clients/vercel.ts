/**
 * Vercel provider client for E2E tests. Spec §12.3.
 *
 * Endpoints:
 *  - GET   /v9/projects          → list (paged)
 *  - POST  /v11/projects         → create
 *  - DELETE /v9/projects/:id      → delete
 *
 * All requests carry `?teamId=` since the test team is the only
 * scope we operate on (cf. `.env.test:VERCEL_TEAM_ID`).
 */

import { E2E_RESOURCE_PREFIX, isE2EResourceName } from '../naming';

const VERCEL_API = 'https://api.vercel.com';

export interface VercelProject {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

export class VercelClient {
  constructor(
    private readonly token: string,
    private readonly teamId: string,
  ) {}

  private url(path: string, query?: Record<string, string>): string {
    const params = new URLSearchParams({ teamId: this.teamId, ...(query ?? {}) });
    return `${VERCEL_API}${path}?${params.toString()}`;
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<{ status: number; body: T | null }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    let bodyStr: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }
    const res = await fetch(this.url(path, query), { method, headers, body: bodyStr });
    if (res.status === 204) return { status: 204, body: null };
    const txt = await res.text();
    if (txt === '') return { status: res.status, body: null };
    return { status: res.status, body: JSON.parse(txt) as T };
  }

  async ping(): Promise<{ id: string; slug?: string }> {
    const { status, body } = await this.req<{ id: string; slug?: string }>(
      'GET',
      `/v2/teams/${this.teamId}`,
    );
    if (status !== 200 || !body) {
      throw new Error(`Vercel team ping failed: ${status}`);
    }
    return body;
  }

  async createProject(name: string, framework: string = 'nextjs'): Promise<VercelProject> {
    const { status, body } = await this.req<VercelProject>('POST', '/v11/projects', {
      name,
      framework,
    });
    if (status !== 200 && status !== 201) {
      throw new Error(`Vercel createProject(${name}) failed: ${status}`);
    }
    if (!body) throw new Error(`Vercel createProject(${name}) returned no body`);
    return body;
  }

  async deleteProject(idOrName: string): Promise<void> {
    const { status } = await this.req('DELETE', `/v9/projects/${encodeURIComponent(idOrName)}`);
    if (status !== 204 && status !== 200 && status !== 404) {
      throw new Error(`Vercel deleteProject(${idOrName}) failed: ${status}`);
    }
  }

  async projectExists(name: string): Promise<boolean> {
    const { status } = await this.req('GET', `/v9/projects/${encodeURIComponent(name)}`);
    if (status === 200) return true;
    if (status === 404) return false;
    throw new Error(`Vercel projectExists(${name}) unexpected status: ${status}`);
  }

  async listE2EProjects(): Promise<VercelProject[]> {
    const out: VercelProject[] = [];
    let until: string | undefined;
    for (let i = 0; i < 5; i++) {
      const query: Record<string, string> = { limit: '100' };
      if (until !== undefined) query.until = until;
      const { status, body } = await this.req<{
        projects: VercelProject[];
        pagination?: { next: string | null };
      }>('GET', '/v9/projects', undefined, query);
      if (status !== 200 || !body) break;
      for (const p of body.projects) {
        if (isE2EResourceName(p.name)) out.push(p);
      }
      const next = body.pagination?.next;
      if (next === null || next === undefined) break;
      until = next;
    }
    return out;
  }

  static readonly prefix = E2E_RESOURCE_PREFIX;
}
