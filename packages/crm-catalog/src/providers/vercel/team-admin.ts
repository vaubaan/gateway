/**
 * `vercel-team-admin` — OrgResourceAdminKind, spec §5.1 / §5.3.
 *
 * Privileged Vercel team credential. Manages the lifecycle of
 * `vercel-project` ProjectResources: provision (createChild), inventory
 * adoption (listChildren), destroy (destroyChild), and admin-mediated
 * rotation of child project tokens (rotateChildAccess).
 *
 * Rotation of the admin token itself is `manual` (spec §0.1): same
 * reason as `vercel-team` — Vercel doesn't expose a stable token
 * rotation API.
 *
 * The provider operations are intentionally **stubs** in Phase 3 —
 * the contract shape is locked in, but the actual Vercel API calls
 * land in Phase 6 (provisioning). Any caller that invokes these
 * methods today gets a `phase-6: not implemented` error so we fail
 * loudly instead of silently no-op'ing.
 */

import type {
  McpServerFragment,
  OrgResourceAdminKind,
  ProviderChild,
} from '../../resource-kind.js';

interface VercelTeamAdminMetadata {
  readonly teamSlug: string;
}

function isVercelTeamAdminMetadata(value: unknown): value is VercelTeamAdminMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { teamSlug?: unknown }).teamSlug === 'string' &&
    (value as { teamSlug: string }).teamSlug.length > 0
  );
}

/**
 * Thrown when the Vercel API cannot rotate a project-scoped token —
 * Vercel only issues team-level tokens, not per-project ones, so
 * rotating a child token means rotating the team token and falls
 * outside this admin's reach. UI surfaces `setupDocs` and prompts for
 * a manual paste.
 */
export class VercelRotationNotSupportedError extends Error {
  readonly setupDocs: string;
  constructor(message: string, setupDocs: string) {
    super(message);
    this.name = 'VercelRotationNotSupportedError';
    this.setupDocs = setupDocs;
  }
}

const VERCEL_ROTATION_FALLBACK_DOCS = `## Manual rotation fallback for \`vercel-project\`

Vercel access tokens are **team-scoped, not project-scoped**. There
is no Vercel API to mint or rotate a token bound to a single project.
The CRM therefore cannot perform admin-mediated rotation for the
\`VERCEL_TOKEN\` Access key of a \`vercel-project\` Resource:

1. As a team Owner/Admin, open
   \`https://vercel.com/account/tokens\`.
2. **Revoke** the old token (Trash icon).
3. **Create Token** with the same team scope and Owner/Admin role.
4. Copy the new token (starts with 24+ alphanumeric chars).
5. Paste it into the CRM **Rotate Access** dialog for this project.
   The CRM seals it client-side; cleartext never reaches the server.
6. Redeploy any pipelines that embed the old token.

The \`VERCEL_TEAM_ID\` and \`VERCEL_PROJECT_ID\` keys are not
secrets — they are stable identifiers and don't need rotation.
`;

interface VercelProjectApiResponse {
  readonly id: string;
  readonly name: string;
  readonly accountId?: string;
  readonly framework?: string | null;
  readonly rootDirectory?: string | null;
  readonly createdAt?: number;
}

function isVercelProjectApiResponse(v: unknown): v is VercelProjectApiResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string';
}

interface VercelTeamProjectSpec {
  readonly name: string;
  readonly framework?: string;
  readonly rootDirectory?: string;
  readonly gitRepository?: {
    readonly type: 'github' | 'gitlab' | 'bitbucket';
    readonly repo: string;
  };
}

function isVercelTeamProjectSpec(v: unknown): v is VercelTeamProjectSpec {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length === 0) return false;
  if (o.framework !== undefined && typeof o.framework !== 'string') return false;
  if (o.rootDirectory !== undefined && typeof o.rootDirectory !== 'string') return false;
  if (o.gitRepository !== undefined) {
    if (typeof o.gitRepository !== 'object' || o.gitRepository === null) return false;
    const g = o.gitRepository as Record<string, unknown>;
    if (g.type !== 'github' && g.type !== 'gitlab' && g.type !== 'bitbucket') return false;
    if (typeof g.repo !== 'string') return false;
  }
  return true;
}

function authHeaders(access: Readonly<Record<string, string>>): {
  headers: Record<string, string>;
  teamId: string;
} {
  const token = access.VERCEL_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('vercel-team-admin: missing VERCEL_TOKEN in access bundle');
  }
  const teamId = access.VERCEL_TEAM_ID;
  if (typeof teamId !== 'string' || teamId.length === 0) {
    throw new Error('vercel-team-admin: missing VERCEL_TEAM_ID in access bundle');
  }
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    teamId,
  };
}

function toProviderChild(p: VercelProjectApiResponse): ProviderChild {
  return {
    providerRef: p.id,
    name: p.name,
    metadata: {
      framework: p.framework ?? null,
      rootDirectory: p.rootDirectory ?? null,
      createdAt: p.createdAt ?? null,
      accountId: p.accountId ?? null,
    },
  };
}

const SETUP_DOCS = `## Provision a Vercel admin token for \`vercel-team-admin\`

This Resource holds a **team-scoped Vercel access token with admin
privileges**. It is the credential the CRM uses to **create, destroy,
and rotate** \`vercel-project\` Resources on your behalf. Treat it
like a root key — only team owners or trusted operators should hold
it.

### 1. Verify your role on the team

Open \`https://vercel.com/<team-slug>/settings/members\` and confirm
your role is **Owner** or **Admin**. Member tokens cannot create or
delete projects.

### 2. Create the admin token

1. Go to \`https://vercel.com/account/tokens\`.
2. Click **Create Token**:
   - **Token Name**: \`crm-vercel-admin-<team-slug>\`.
   - **Scope**: pick the target team. The token inherits your role
     on that team, so it will have admin capability if you do.
   - **Expiration**: shorter is better — the CRM will warn you 14
     days before. 90 days is a sane upper bound for an admin token.
3. **Copy** the token immediately (you cannot view it again).

### 3. Find the team identifier

Same as for \`vercel-team\`:

\`\`\`sh
curl -fsS -H "Authorization: Bearer <YOUR_TOKEN>" \\
  https://api.vercel.com/v2/teams | jq '.teams[] | {id,slug}'
\`\`\`

### 4. Paste into the CRM wizard

- \`VERCEL_TOKEN\`: the token from step 2.
- \`VERCEL_TEAM_ID\`: the \`team_xxx\` identifier from step 3.

The CRM seals both client-side (spec §4). Cleartext never leaves the
browser.

### What this Resource manages

Once registered, this admin can:

- Create new \`vercel-project\` Resources under its team (Phase 6
  provisioning).
- Adopt existing projects as managed Resources (Phase 6
  inventory-adoption flow).
- Rotate child project tokens (\`admin-mediated\` rotation, spec
  §0.1).

### Rotation

Regenerate via the Vercel dashboard (delete the old token, create a
new one with the same scope and admin role) and paste the new value
into the CRM "Rotate Access" flow.
`;

export const vercelTeamAdmin: OrgResourceAdminKind = {
  id: 'vercel-team-admin',
  provider: 'vercel',
  kindClass: 'org-admin',
  displayName: 'Vercel team (admin)',
  setupDocs: SETUP_DOCS,
  accessSchema: {
    VERCEL_TOKEN: {
      label: 'Team-scoped Vercel admin token',
      description:
        'Vercel access token issued by a team Owner/Admin, scoped to a single ' +
        'team. Enables project creation, destruction, and child-token ' +
        'rotation.',
      required: true,
      pattern: '^[A-Za-z0-9]{24,}$',
    },
    VERCEL_TEAM_ID: {
      label: 'Vercel team id',
      description:
        'Opaque team identifier (looks like `team_xxxxxxxxxxxxxxxx`). Stable ' +
        'across token rotations.',
      required: true,
      pattern: '^team_[A-Za-z0-9]{10,}$',
    },
  },
  metadataSchema: {
    description: 'VercelTeamAdminMetadata: { teamSlug: string }',
    fields: { teamSlug: { type: 'string', required: true } },
  },
  rotationMethod: 'manual',
  manages: ['vercel-project'],
  healthTestCmd(metadata, _access): string {
    if (!isVercelTeamAdminMetadata(metadata)) {
      throw new Error('vercel-team-admin: invalid metadata, expected { teamSlug: string }');
    }
    // Listing projects under the team is admin-gated past a certain
    // permission level on Vercel — a member-only token will 403 on
    // create/destroy. We hit the team-info endpoint which returns the
    // caller's role; admin-capable role is what we want.
    return (
      `curl -fsS -H "Authorization: Bearer $VERCEL_TOKEN" ` +
      `"https://api.vercel.com/v2/teams/${metadata.teamSlug}" | ` +
      `jq -e '.membership.role | IN("OWNER","DEVELOPER","ADMIN","BILLING")' >/dev/null`
    );
  },
  mcpFragment(_metadata): McpServerFragment | null {
    return {
      type: 'http',
      url: 'https://mcp.vercel.com/',
    };
  },
  egressHosts(_metadata): readonly string[] {
    return ['api.vercel.com', 'vercel.com', 'mcp.vercel.com'];
  },
  /**
   * GET /v9/projects?teamId={teamId}&limit=100 — paginated via the
   * `pagination.next` cursor on the response body.
   */
  async listChildren(access): Promise<readonly ProviderChild[]> {
    const { headers, teamId } = authHeaders(access);
    const all: ProviderChild[] = [];
    let until: string | null = null;
    while (true) {
      const u = new URL('https://api.vercel.com/v9/projects');
      u.searchParams.set('teamId', teamId);
      u.searchParams.set('limit', '100');
      if (until !== null) u.searchParams.set('until', until);
      const resp = await fetch(u.toString(), { headers });
      if (!resp.ok) {
        throw new Error(
          `vercel-team-admin: listChildren failed (${resp.status} ${resp.statusText})`,
        );
      }
      const body: unknown = await resp.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        !Array.isArray((body as { projects?: unknown }).projects)
      ) {
        throw new Error('vercel-team-admin: listChildren expected { projects: [...] }');
      }
      const projects = (body as { projects: unknown[] }).projects;
      for (const p of projects) {
        if (isVercelProjectApiResponse(p)) all.push(toProviderChild(p));
      }
      const pagination = (body as { pagination?: { next?: number | string | null } }).pagination;
      const nextCursor = pagination?.next;
      if (nextCursor === null || nextCursor === undefined || nextCursor === '') break;
      until = String(nextCursor);
    }
    return all;
  },
  /**
   * POST /v10/projects?teamId={teamId} — create a new project.
   *
   * 409 means a project with the same name already exists for the
   * team. We surface that with a thrown Error that includes the
   * Vercel error message tail.
   */
  async createChild(access, spec): Promise<ProviderChild> {
    if (!isVercelTeamProjectSpec(spec)) {
      throw new Error(
        'vercel-team-admin: createChild expects { name, framework?, rootDirectory?, gitRepository? }',
      );
    }
    const { headers, teamId } = authHeaders(access);
    const body: Record<string, unknown> = {
      name: spec.name,
    };
    if (spec.framework !== undefined) body.framework = spec.framework;
    if (spec.rootDirectory !== undefined) body.rootDirectory = spec.rootDirectory;
    if (spec.gitRepository !== undefined) body.gitRepository = spec.gitRepository;
    const resp = await fetch(
      `https://api.vercel.com/v10/projects?teamId=${encodeURIComponent(teamId)}`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (resp.status === 409) {
      const text = await resp.text();
      throw new Error(`vercel-team-admin: createChild conflict (409): ${text.slice(0, 200)}`);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `vercel-team-admin: createChild failed (${resp.status} ${resp.statusText}): ${text.slice(0, 200)}`,
      );
    }
    const data: unknown = await resp.json();
    if (!isVercelProjectApiResponse(data)) {
      throw new Error('vercel-team-admin: createChild returned unexpected shape');
    }
    return toProviderChild(data);
  },
  /**
   * DELETE /v9/projects/{projectId}?teamId={teamId} — idempotent. 404
   * is success (already gone).
   */
  async destroyChild(access, providerRef): Promise<void> {
    const { headers, teamId } = authHeaders(access);
    if (typeof providerRef !== 'string' || providerRef.length === 0) {
      throw new Error('vercel-team-admin: destroyChild expects providerRef=projectId');
    }
    const resp = await fetch(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(providerRef)}?teamId=${encodeURIComponent(teamId)}`,
      { method: 'DELETE', headers },
    );
    if (resp.status === 404 || resp.status === 204 || resp.ok) return;
    const text = await resp.text();
    throw new Error(
      `vercel-team-admin: destroyChild failed (${resp.status} ${resp.statusText}): ${text.slice(0, 200)}`,
    );
  },
  /**
   * Vercel does not expose a per-project token mint/rotate endpoint
   * (tokens are team-level). We always throw
   * `VercelRotationNotSupportedError` so the UI falls back to a manual
   * "revoke + recreate team token" flow.
   *
   * Spec §0.1 fallback path.
   */
  rotateChildAccess(_access, _childProviderRef, accessKey): Promise<string> {
    return Promise.reject(
      new VercelRotationNotSupportedError(
        `vercel-team-admin: cannot rotate ${accessKey} — Vercel only issues team-level tokens; rotate via dashboard and paste manually`,
        VERCEL_ROTATION_FALLBACK_DOCS,
      ),
    );
  },
};
