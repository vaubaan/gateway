/**
 * GitHub provider client for E2E tests (real API, no mock). Spec §12.3.
 *
 * Wraps only the operations the E2E flows need:
 *  - createRepo / deleteRepo  (sweeper + scenario 2)
 *  - listOrgRepos             (sweeper)
 *  - getViewerLogin           (token validation)
 *
 * Uses the admin PAT from `.env.test` (GITHUB_ORG_ADMIN_TOKEN). No
 * sealed_blob handling here — the cleartext is provided in-process to
 * call the HTTPS endpoint, just like a browser session would.
 *
 * Rate limits: GitHub's REST API caps at 5000 req/hr for an authenticated
 * PAT — orders of magnitude above what any nightly E2E run needs.
 */

import { E2E_RESOURCE_PREFIX, isE2EResourceName } from '../naming';

const GH_API = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const VERSION = '2022-11-28';

export interface GithubRepo {
  readonly name: string;
  readonly full_name: string;
  readonly created_at: string;
  readonly private: boolean;
}

export class GithubClient {
  constructor(
    private readonly token: string,
    private readonly org: string,
  ) {}

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T | null }> {
    const headers: Record<string, string> = {
      Accept: ACCEPT,
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': VERSION,
    };
    let bodyStr: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }
    const res = await fetch(`${GH_API}${path}`, { method, headers, body: bodyStr });
    if (res.status === 204) return { status: 204, body: null };
    const txt = await res.text();
    if (txt === '') return { status: res.status, body: null };
    return { status: res.status, body: JSON.parse(txt) as T };
  }

  async getViewerLogin(): Promise<string> {
    const { status, body } = await this.req<{ login: string }>('GET', '/user');
    if (status !== 200 || !body) {
      throw new Error(`GitHub /user failed: ${status}`);
    }
    return body.login;
  }

  async createRepo(name: string, opts?: { private?: boolean }): Promise<GithubRepo> {
    const { status, body } = await this.req<GithubRepo>('POST', `/orgs/${this.org}/repos`, {
      name,
      private: opts?.private ?? true,
      auto_init: false,
      description: 'vauban-e2e transient — auto-cleanup',
    });
    if (status !== 201 || !body) {
      throw new Error(`GitHub createRepo(${name}) failed: ${status}`);
    }
    return body;
  }

  async repoExists(name: string): Promise<boolean> {
    const { status } = await this.req('GET', `/repos/${this.org}/${name}`);
    if (status === 200) return true;
    if (status === 404) return false;
    throw new Error(`GitHub repoExists(${name}) unexpected status: ${status}`);
  }

  async deleteRepo(name: string): Promise<void> {
    const { status } = await this.req('DELETE', `/repos/${this.org}/${name}`);
    if (status !== 204 && status !== 404) {
      throw new Error(`GitHub deleteRepo(${name}) failed: ${status}`);
    }
  }

  /**
   * List org repos matching the `vauban-e2e-*` prefix.
   * Uses paged listing; returns up to 300 (3 pages * 100) which is
   * more than any orphan backlog should ever contain.
   */
  async listE2ERepos(): Promise<GithubRepo[]> {
    const out: GithubRepo[] = [];
    for (let page = 1; page <= 3; page++) {
      const { status, body } = await this.req<GithubRepo[]>(
        'GET',
        `/orgs/${this.org}/repos?per_page=100&page=${page}&type=all`,
      );
      if (status !== 200 || !body) break;
      for (const r of body) {
        if (isE2EResourceName(r.name)) out.push(r);
      }
      if (body.length < 100) break;
    }
    return out;
  }

  static readonly prefix = E2E_RESOURCE_PREFIX;
}
