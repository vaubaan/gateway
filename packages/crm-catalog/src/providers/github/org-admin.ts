/**
 * `github-org-admin` — OrgResourceAdminKind, spec §5.1 / §5.3.
 *
 * Privileged GitHub org credential. Manages the lifecycle of
 * `github-repo` ProjectResources: provision (createChild), inventory
 * adoption (listChildren), destroy (destroyChild), and admin-mediated
 * rotation of child repo deploy tokens (rotateChildAccess).
 *
 * Rotation of the admin token itself is `manual` (spec §0.1): there's
 * no public GitHub API to regenerate a fine-grained PAT.
 *
 * Phase 6 lights up the provider operations: the four methods below
 * call `api.github.com` directly via `fetch`. They are intended to run
 * **in the browser** with the admin token unsealed transitorily (ZK
 * invariant, spec §4). Core never sees the cleartext token.
 */

import type {
  McpServerFragment,
  OrgResourceAdminKind,
  ProviderChild,
} from '../../resource-kind.js';

interface GithubOrgAdminMetadata {
  /** GitHub organization login the admin token belongs to. */
  readonly org: string;
}

function isGithubOrgAdminMetadata(value: unknown): value is GithubOrgAdminMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { org?: unknown }).org === 'string' &&
    (value as { org: string }).org.length > 0
  );
}

/**
 * Thrown when the GitHub fine-grained PAT cannot rotate a child token
 * because the relevant endpoint is GitHub App-only or the org policy
 * forbids fine-grained tokens. The caller surfaces `setupDocs` to the
 * operator, who falls back to the manual procedure.
 */
export class GitHubRotationNotSupportedError extends Error {
  readonly setupDocs: string;
  constructor(message: string, setupDocs: string) {
    super(message);
    this.name = 'GitHubRotationNotSupportedError';
    this.setupDocs = setupDocs;
  }
}

const SETUP_DOCS = `## Provision a fine-grained PAT for \`github-org-admin\` (read + write)

This Resource holds a **privileged** GitHub Personal Access Token
scoped to a single organization. It is the credential the CRM uses to
**create, destroy, and rotate** \`github-repo\` Resources on your
behalf. Treat it like a root key — only org owners or trusted
operators should hold it.

### 1. Open the GitHub PAT settings

Sign in as an **org owner** (the token needs write capability the
member role cannot grant) and go to
\`https://github.com/settings/personal-access-tokens/new\`. Pick
**Fine-grained personal access token**.

### 2. Scope the token to the org

- **Resource owner**: select the target organization.
- **Expiration**: shorter is better; the CRM will warn you 14 days
  before. 90 days is a sane upper bound for an admin token.
- **Repository access**: \`All repositories\` (the admin must be able
  to create new ones).

### 3. Pick the read-write permissions

Under **Permissions → Repository permissions**:

- \`Administration\`: **Read and write** (required — lets the CRM
  create/destroy repos and regenerate deploy tokens).
- \`Contents\`: **Read-only** (for inventory adoption).
- \`Metadata\`: **Read-only** (always mandatory).

Under **Permissions → Organization permissions**:

- \`Administration\`: **Read and write** (required for repo
  creation under the org).
- \`Members\`: **Read-only** (optional).

### 4. Generate and paste

Click **Generate token**. The value starts with \`github_pat_\`. Paste
it into the CRM wizard under \`GITHUB_TOKEN\`. The CRM seals it
client-side (spec §4). Cleartext never leaves the browser.

### What this Resource manages

Once registered, this admin can:

- Create new \`github-repo\` Resources under its org via the
  CRM "+ Add Resource" wizard (Phase 6).
- Adopt existing repos as managed Resources (Phase 6
  inventory-adoption flow).
- Rotate child repo deploy tokens (\`admin-mediated\` rotation, spec
  §0.1).

### Rotation

Same procedure as \`github-org\`: regenerate manually via the GitHub
UI, paste into the CRM "Rotate Access" flow.
`;

const GITHUB_ROTATION_FALLBACK_DOCS = `## Manual rotation fallback for \`github-repo\`

GitHub's REST API does not expose **fine-grained PAT issuance** to
arbitrary callers — that endpoint is GitHub App-only and requires
\`/personal-access-tokens\` permissions on the org. When the CRM
detects that the admin's PAT cannot mint a child token, it falls back
to **manual rotation**:

1. As an org owner, open
   \`https://github.com/settings/personal-access-tokens/new\`.
2. Create a new fine-grained PAT scoped to the target repo only with
   \`Contents: Read and write\`, \`Actions: Read and write\`,
   \`Pull requests: Read and write\`.
3. Copy the token (starts with \`github_pat_\`).
4. Paste it into the CRM **Rotate Access** dialog. The CRM seals it
   client-side; cleartext never reaches the server.
`;

interface GithubRepoSpec {
  readonly name: string;
  readonly private?: boolean;
  readonly description?: string;
}

interface GithubRepoApiResponse {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly private: boolean;
  readonly default_branch: string;
  readonly archived: boolean;
  readonly html_url: string;
}

function isGithubRepoApiResponse(v: unknown): v is GithubRepoApiResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'number' &&
    typeof o.name === 'string' &&
    typeof o.full_name === 'string' &&
    typeof o.private === 'boolean' &&
    typeof o.default_branch === 'string' &&
    typeof o.archived === 'boolean'
  );
}

function authHeaders(access: Readonly<Record<string, string>>): Record<string, string> {
  const token = access.GITHUB_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('github-org-admin: missing GITHUB_TOKEN in access bundle');
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function toProviderChild(r: GithubRepoApiResponse): ProviderChild {
  return {
    providerRef: r.full_name,
    name: r.name,
    metadata: {
      default_branch: r.default_branch,
      private: r.private,
      archived: r.archived,
      html_url: r.html_url,
      id: r.id,
    },
  };
}

/**
 * Pagination of GET /orgs/{org}/repos via the standard `Link` header
 * (rel=next). 100 per page max. Stops when no `next` link or the page
 * is empty.
 */
async function listOrgReposPaginated(
  org: string,
  headers: Record<string, string>,
): Promise<ProviderChild[]> {
  const all: ProviderChild[] = [];
  let next: string | null =
    `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?per_page=100&type=all`;
  while (next !== null) {
    const resp: Response = await fetch(next, { headers });
    if (!resp.ok) {
      throw new Error(`github-org-admin: listChildren failed (${resp.status} ${resp.statusText})`);
    }
    const body: unknown = await resp.json();
    if (!Array.isArray(body)) {
      throw new Error('github-org-admin: listChildren expected array response');
    }
    for (const r of body) {
      if (isGithubRepoApiResponse(r)) all.push(toProviderChild(r));
    }
    next = parseNextLink(resp.headers.get('link'));
  }
  return all;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (linkHeader === null || linkHeader.length === 0) return null;
  // Format: `<https://...>; rel="next", <https://...>; rel="last"`
  const parts = linkHeader.split(',');
  for (const p of parts) {
    const m = p.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1] ?? null;
  }
  return null;
}

function isGithubRepoSpec(v: unknown): v is GithubRepoSpec {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length === 0) return false;
  if (o.private !== undefined && typeof o.private !== 'boolean') return false;
  if (o.description !== undefined && typeof o.description !== 'string') return false;
  return true;
}

// Tiny "void use" to keep the type-narrowing helper referenced even
// when the kind metadata is destructured directly by the wrapper.
void isGithubOrgAdminMetadata;

export const githubOrgAdmin: OrgResourceAdminKind = {
  id: 'github-org-admin',
  provider: 'github',
  kindClass: 'org-admin',
  displayName: 'GitHub organization (admin)',
  setupDocs: SETUP_DOCS,
  accessSchema: {
    GITHUB_TOKEN: {
      label: 'Fine-grained PAT (admin, org-scoped)',
      description:
        'GitHub fine-grained personal access token issued by an org owner, ' +
        'with Repository "Administration: Read and write" and Organization ' +
        '"Administration: Read and write". Starts with `github_pat_`.',
      required: true,
      pattern: '^github_pat_[A-Za-z0-9_]{20,}$',
    },
  },
  metadataSchema: {
    description: 'GithubOrgAdminMetadata: { org: string }',
    fields: { org: { type: 'string', required: true } },
  },
  rotationMethod: 'manual',
  manages: ['github-repo'],
  healthTestCmd(metadata, _access): string {
    if (!isGithubOrgAdminMetadata(metadata)) {
      throw new Error('github-org-admin: invalid metadata, expected { org: string }');
    }
    // Hit a write-capable endpoint (org membership listing requires the
    // admin scope). Health = "the token still has admin reach".
    return (
      `curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" ` +
      `"https://api.github.com/orgs/${metadata.org}/memberships/$(` +
      `curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | jq -r .login` +
      `)" | jq -e '.role=="admin"' >/dev/null`
    );
  },
  mcpFragment(metadata): McpServerFragment | null {
    if (!isGithubOrgAdminMetadata(metadata)) {
      return null;
    }
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
  egressHosts(_metadata): readonly string[] {
    return ['api.github.com', 'github.com', 'ghcr.io'];
  },
  /**
   * GET /orgs/{org}/repos — paginated, 100 per page. Returns the full
   * list of repos the admin can see (visibility=all). Each `repo` is
   * mapped to a `ProviderChild { providerRef='owner/repo' }`.
   *
   * The org login is carried in `access.GITHUB_ORG`. The wrapper layer
   * in packages/web sets it before delegating from the kind+metadata —
   * the contract `listChildren(access)` does not pass metadata.
   */
  async listChildren(access): Promise<readonly ProviderChild[]> {
    const headers = authHeaders(access);
    const org = access.GITHUB_ORG;
    if (typeof org !== 'string' || org.length === 0) {
      throw new Error(
        'github-org-admin: listChildren requires access.GITHUB_ORG to be set by the caller',
      );
    }
    return await listOrgReposPaginated(org, headers);
  },
  /**
   * POST /orgs/{org}/repos — create a new repo. Returns the
   * `ProviderChild` reflecting GitHub's view of the resource.
   *
   * 422 on name conflict surfaces as a thrown Error with the GitHub
   * `errors[].message` joined.
   */
  async createChild(access, spec): Promise<ProviderChild> {
    const headers = authHeaders(access);
    const org = access.GITHUB_ORG;
    if (typeof org !== 'string' || org.length === 0) {
      throw new Error(
        'github-org-admin: createChild requires access.GITHUB_ORG to be set by the caller',
      );
    }
    if (!isGithubRepoSpec(spec)) {
      throw new Error(
        'github-org-admin: createChild expects { name: string, private?: boolean, description?: string }',
      );
    }
    const body = {
      name: spec.name,
      private: spec.private ?? true,
      description: spec.description ?? null,
      auto_init: true,
    };
    const resp = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/repos`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.status === 422) {
      const text = await resp.text();
      throw new Error(`github-org-admin: createChild conflict (422): ${text.slice(0, 200)}`);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `github-org-admin: createChild failed (${resp.status} ${resp.statusText}): ${text.slice(0, 200)}`,
      );
    }
    const data: unknown = await resp.json();
    if (!isGithubRepoApiResponse(data)) {
      throw new Error('github-org-admin: createChild returned unexpected shape');
    }
    return toProviderChild(data);
  },
  /**
   * DELETE /repos/{owner}/{repo} — idempotent. 404 is success (already
   * gone).
   */
  async destroyChild(access, providerRef): Promise<void> {
    const headers = authHeaders(access);
    if (typeof providerRef !== 'string' || !providerRef.includes('/')) {
      throw new Error("github-org-admin: destroyChild expects providerRef='owner/repo'");
    }
    const [owner, repo] = providerRef.split('/', 2);
    const resp = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}`,
      { method: 'DELETE', headers },
    );
    if (resp.status === 404 || resp.status === 204 || resp.ok) return;
    const text = await resp.text();
    throw new Error(
      `github-org-admin: destroyChild failed (${resp.status} ${resp.statusText}): ${text.slice(0, 200)}`,
    );
  },
  /**
   * Rotate a child repo deploy token.
   *
   * GitHub does **not** expose a stable, non-App API to mint
   * fine-grained PATs. Two fallback strategies exist:
   *
   *  (a) Use `/orgs/{org}/personal-access-tokens` issuance endpoint —
   *      only available to GitHub Apps acting on behalf of org owners.
   *      PAT-authenticated callers always get 403.
   *  (b) Provision a Deploy Key (SSH key pair, repo-scoped). This
   *      works but does not produce a `github_pat_*` token compatible
   *      with the kind's accessSchema.
   *
   * For Phase 6 we attempt (a), and on 403/404 throw
   * `GitHubRotationNotSupportedError` so the UI falls back to the
   * manual paste flow. This keeps the contract honest.
   */
  async rotateChildAccess(access, childProviderRef, accessKey): Promise<string> {
    if (accessKey !== 'GITHUB_TOKEN') {
      throw new GitHubRotationNotSupportedError(
        `github-org-admin: cannot rotate access key ${accessKey} (only GITHUB_TOKEN is supported)`,
        GITHUB_ROTATION_FALLBACK_DOCS,
      );
    }
    const headers = authHeaders(access);
    const org = access.GITHUB_ORG;
    if (typeof org !== 'string' || org.length === 0) {
      throw new GitHubRotationNotSupportedError(
        'github-org-admin: rotateChildAccess requires access.GITHUB_ORG; falling back to manual paste',
        GITHUB_ROTATION_FALLBACK_DOCS,
      );
    }
    if (typeof childProviderRef !== 'string' || !childProviderRef.includes('/')) {
      throw new Error("github-org-admin: rotateChildAccess expects childProviderRef='owner/repo'");
    }

    // Attempt the App-only fine-grained PAT issuance endpoint. On 403
    // (PAT not allowed) or 404 (endpoint absent on this org plan), we
    // fall back to manual rotation.
    const resp = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(org)}/personal-access-tokens`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repository_selection: 'selected',
          repositories: [childProviderRef.split('/', 2)[1]],
          permissions: {
            contents: 'write',
            actions: 'write',
            pull_requests: 'write',
            metadata: 'read',
          },
        }),
      },
    );

    if (resp.status === 403 || resp.status === 404 || resp.status === 422) {
      throw new GitHubRotationNotSupportedError(
        `github-org-admin: GitHub did not allow API rotation (${resp.status}); use manual fallback`,
        GITHUB_ROTATION_FALLBACK_DOCS,
      );
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `github-org-admin: rotateChildAccess failed (${resp.status} ${resp.statusText}): ${text.slice(0, 200)}`,
      );
    }
    const data: unknown = await resp.json();
    if (
      typeof data !== 'object' ||
      data === null ||
      typeof (data as { token?: unknown }).token !== 'string'
    ) {
      throw new GitHubRotationNotSupportedError(
        'github-org-admin: rotation response missing { token: string }; use manual fallback',
        GITHUB_ROTATION_FALLBACK_DOCS,
      );
    }
    return (data as { token: string }).token;
  },
};
