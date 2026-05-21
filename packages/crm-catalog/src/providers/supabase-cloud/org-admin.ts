/**
 * `supabase-org-admin` — OrgResourceAdminKind, spec §5.1 / §5.3.
 *
 * Privileged Supabase organization credential. Manages the lifecycle
 * of `supabase-project` ProjectResources: provision (createChild),
 * inventory adoption (listChildren), destroy (destroyChild), and
 * admin-mediated rotation of child project credentials
 * (rotateChildAccess).
 *
 * Rotation of the admin token itself is `manual` (spec §0.1): same
 * reason as `supabase-org` — Supabase doesn't expose a stable PAT
 * rotation API. The user regenerates manually and re-pastes.
 *
 * The provider operations are intentionally **stubs** in Phase 3 —
 * the contract shape is locked in, but the actual Supabase Management
 * API calls (create project, regenerate service_role key, rotate DB
 * password) land in Phase 6 (provisioning). Any caller that invokes
 * these methods today gets a `phase-6:` marker rejection so we fail
 * loudly instead of silently no-op'ing.
 */

import type {
  McpServerFragment,
  OrgResourceAdminKind,
  ProviderChild,
} from '../../resource-kind.js';

interface SupabaseOrgAdminMetadata {
  readonly orgSlug: string;
}

function isSupabaseOrgAdminMetadata(value: unknown): value is SupabaseOrgAdminMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { orgSlug?: unknown }).orgSlug === 'string' &&
    (value as { orgSlug: string }).orgSlug.length > 0
  );
}

/**
 * Thrown when Supabase doesn't expose a stable API to rotate the
 * requested access key (e.g. service_role JWTs, which can only be
 * rotated from the Supabase dashboard). UI surfaces `setupDocs` and
 * prompts for a manual paste.
 */
export class SupabaseRotationNotSupportedError extends Error {
  readonly setupDocs: string;
  constructor(message: string, setupDocs: string) {
    super(message);
    this.name = 'SupabaseRotationNotSupportedError';
    this.setupDocs = setupDocs;
  }
}

const SUPABASE_SERVICE_ROLE_ROTATION_FALLBACK_DOCS = `## Manual rotation fallback for \`SUPABASE_SERVICE_ROLE_KEY\`

The Supabase Management API does not expose a public endpoint to
**regenerate JWT signing keys** for a project — that operation lives
behind the dashboard's "Rotate API keys" button only.

To rotate the service_role key:

1. As an org Owner/Admin, open
   \`https://supabase.com/dashboard/project/{ref}/settings/api\`.
2. Click **Reset all API keys** (this rotates anon + service_role).
3. Copy the new \`service_role\` JWT (starts with \`eyJ...\`).
4. Paste it into the CRM **Rotate Access** dialog for this project.
   The CRM seals it client-side; cleartext never reaches the server.
5. Also paste the new \`SUPABASE_ANON_KEY\` if it changed (it does).
6. Redeploy any pipelines that embed the old keys.
`;

interface SupabaseProjectApiResponse {
  readonly id: string;
  readonly name: string;
  readonly organization_id: string;
  readonly region?: string;
  readonly created_at?: string;
  readonly status?: string;
  readonly database?: {
    readonly host?: string;
    readonly version?: string;
  };
}

function isSupabaseProjectApiResponse(v: unknown): v is SupabaseProjectApiResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' && typeof o.name === 'string' && typeof o.organization_id === 'string'
  );
}

interface SupabaseProjectSpec {
  readonly name: string;
  readonly region: string;
  readonly db_pass: string;
  readonly organization_id: string;
  readonly plan?: 'free' | 'pro' | 'team' | 'enterprise';
}

function isSupabaseProjectSpec(v: unknown): v is SupabaseProjectSpec {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    typeof o.region === 'string' &&
    o.region.length > 0 &&
    typeof o.db_pass === 'string' &&
    o.db_pass.length > 0 &&
    typeof o.organization_id === 'string' &&
    o.organization_id.length > 0 &&
    (o.plan === undefined ||
      o.plan === 'free' ||
      o.plan === 'pro' ||
      o.plan === 'team' ||
      o.plan === 'enterprise')
  );
}

function authHeaders(access: Readonly<Record<string, string>>): Record<string, string> {
  const token = access.SUPABASE_ACCESS_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('supabase-org-admin: missing SUPABASE_ACCESS_TOKEN in access bundle');
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

function toProviderChild(p: SupabaseProjectApiResponse): ProviderChild {
  return {
    providerRef: p.id,
    name: p.name,
    metadata: {
      organization_id: p.organization_id,
      region: p.region ?? null,
      status: p.status ?? null,
      created_at: p.created_at ?? null,
      database_host: p.database?.host ?? null,
      database_version: p.database?.version ?? null,
    },
  };
}

const SETUP_DOCS = `## Provision a Supabase admin PAT for \`supabase-org-admin\`

This Resource holds a Supabase **Personal Access Token** issued by an
**Owner** or **Admin** of the target organization. It is the
credential the CRM uses to **create, destroy, and rotate**
\`supabase-project\` Resources on your behalf. Treat it like a root
key — only org owners or trusted operators should hold it.

### 1. Verify your role on the organization

1. Open \`https://supabase.com/dashboard/org/<org-slug>/team\`.
2. Confirm your role is **Owner** or **Administrator**. Member roles
   cannot create or delete projects, nor regenerate service_role
   keys.

### 2. Create the PAT

1. Open \`https://supabase.com/dashboard/account/tokens\`.
2. Click **Generate new token**:
   - **Name**: \`crm-supabase-admin-<org-slug>\`.
   - Supabase doesn't scope PATs per-org — the token inherits your
     role across every org you belong to. For strict isolation,
     dedicate a Supabase account to admin operations.
3. Copy the token value immediately (single-view).

### 3. Find the organization slug

Same as for \`supabase-org\`:

\`\`\`sh
curl -fsS -H "Authorization: Bearer <YOUR_TOKEN>" \\
  https://api.supabase.com/v1/organizations | jq '.[] | {id,slug,name}'
\`\`\`

### 4. Paste into the CRM wizard

- \`SUPABASE_ACCESS_TOKEN\`: the PAT from step 2.

The CRM seals it client-side (spec §4). Cleartext never reaches the
server.

### What this Resource manages

Once registered, this admin can:

- Create new \`supabase-project\` Resources under its organization
  (Phase 6 provisioning — POST \`/v1/projects\`).
- Adopt existing projects as managed Resources (Phase 6
  inventory-adoption — GET \`/v1/projects\` then re-issue creds).
- Rotate child project credentials (\`admin-mediated\` rotation,
  spec §0.1): regenerate the service_role key
  (POST \`/v1/projects/{ref}/api-keys\`) and the DB password
  (POST \`/v1/projects/{ref}/database/password\`).

### Rotation

Regenerate via the Supabase dashboard (revoke old, generate new with
the same Owner/Admin role) and paste the new value into the CRM
"Rotate Access" flow.
`;

export const supabaseOrgAdmin: OrgResourceAdminKind = {
  id: 'supabase-org-admin',
  provider: 'supabase-cloud',
  kindClass: 'org-admin',
  displayName: 'Supabase organization (admin)',
  setupDocs: SETUP_DOCS,
  accessSchema: {
    SUPABASE_ACCESS_TOKEN: {
      label: 'Supabase admin Personal Access Token',
      description:
        'PAT issued by an org Owner/Admin via ' +
        'supabase.com/dashboard/account/tokens. Enables project creation, ' +
        'destruction, and child-credential rotation (service_role + DB ' +
        'password).',
      required: true,
      pattern: '^sbp_[A-Za-z0-9]{20,}$',
    },
  },
  metadataSchema: {
    description: 'SupabaseOrgAdminMetadata: { orgSlug: string }',
    fields: { orgSlug: { type: 'string', required: true } },
  },
  rotationMethod: 'manual',
  manages: ['supabase-project'],
  healthTestCmd(metadata, _access): string {
    if (!isSupabaseOrgAdminMetadata(metadata)) {
      throw new Error('supabase-org-admin: invalid metadata, expected { orgSlug: string }');
    }
    // The /v1/organizations endpoint returns the caller's role per org.
    // We require Owner or Administrator to confirm admin capability.
    return (
      `curl -fsS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" ` +
      `https://api.supabase.com/v1/organizations | ` +
      `jq -e '.[] | select(.slug == "${metadata.orgSlug}") | ` +
      `select(.role_name | IN("Owner","Administrator"))' >/dev/null`
    );
  },
  mcpFragment(_metadata): McpServerFragment | null {
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
  egressHosts(_metadata): readonly string[] {
    return ['api.supabase.com', 'supabase.com'];
  },
  /**
   * GET /v1/projects — returns every project visible to the PAT,
   * across all orgs the caller belongs to. The browser caller is
   * expected to filter by `access.SUPABASE_ORG_ID` if present (the
   * wrapper layer sets it from `resource.provider_metadata.orgSlug`
   * resolved at registration time).
   */
  async listChildren(access): Promise<readonly ProviderChild[]> {
    const headers = authHeaders(access);
    const resp = await fetch('https://api.supabase.com/v1/projects', { headers });
    if (!resp.ok) {
      throw new Error(
        `supabase-org-admin: listChildren failed (${resp.status} ${resp.statusText})`,
      );
    }
    const body: unknown = await resp.json();
    if (!Array.isArray(body)) {
      throw new Error('supabase-org-admin: listChildren expected array response');
    }
    const orgFilter = access.SUPABASE_ORG_ID;
    const children: ProviderChild[] = [];
    for (const p of body) {
      if (!isSupabaseProjectApiResponse(p)) continue;
      if (
        typeof orgFilter === 'string' &&
        orgFilter.length > 0 &&
        p.organization_id !== orgFilter
      ) {
        continue;
      }
      children.push(toProviderChild(p));
    }
    return children;
  },
  /**
   * POST /v1/projects — provision a new project.
   *
   * Supabase responds within seconds with `{ id, status: 'PROVISIONING' }`
   * (or `ACTIVE_HEALTHY` on quick paths). The caller must poll
   * `GET /v1/projects/{ref}` if it needs the project to be ready.
   * Phase 6 returns the response as-is; the wizard surfaces a
   * "provisioning" badge until status flips.
   *
   * 4xx responses surface as thrown Errors with the body tail.
   */
  async createChild(access, spec): Promise<ProviderChild> {
    if (!isSupabaseProjectSpec(spec)) {
      throw new Error(
        'supabase-org-admin: createChild expects { name, region, db_pass, organization_id, plan? }',
      );
    }
    const headers = authHeaders(access);
    const body: Record<string, unknown> = {
      name: spec.name,
      region: spec.region,
      db_pass: spec.db_pass,
      organization_id: spec.organization_id,
    };
    if (spec.plan !== undefined) body.plan = spec.plan;
    const resp = await fetch('https://api.supabase.com/v1/projects', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.status === 409) {
      const text = await resp.text();
      throw new Error(`supabase-org-admin: createChild conflict (409): ${text.slice(0, 200)}`);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `supabase-org-admin: createChild failed (${resp.status} ${resp.statusText}): ${text.slice(0, 200)}`,
      );
    }
    const data: unknown = await resp.json();
    if (!isSupabaseProjectApiResponse(data)) {
      throw new Error('supabase-org-admin: createChild returned unexpected shape');
    }
    return toProviderChild(data);
  },
  /**
   * DELETE /v1/projects/{ref} — idempotent. 404 is success (already
   * gone). Note: Supabase soft-deletes; the project is unreachable
   * within seconds but the ref remains reserved for ~90 days.
   */
  async destroyChild(access, providerRef): Promise<void> {
    if (typeof providerRef !== 'string' || providerRef.length === 0) {
      throw new Error('supabase-org-admin: destroyChild expects providerRef=projectRef');
    }
    const headers = authHeaders(access);
    const resp = await fetch(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(providerRef)}`,
      { method: 'DELETE', headers },
    );
    if (resp.status === 404 || resp.status === 204 || resp.ok) return;
    const text = await resp.text();
    throw new Error(
      `supabase-org-admin: destroyChild failed (${resp.status} ${resp.statusText}): ${text.slice(0, 200)}`,
    );
  },
  /**
   * Rotate one access key of a child project.
   *
   *   - `SUPABASE_DB_PASSWORD`     → PATCH /v1/projects/{ref} with
   *     `{ db_pass: <new> }`. Caller must generate a strong password
   *     client-side and pass it via the third argument? No — the
   *     contract is `rotateChildAccess(access, ref, key)` returning a
   *     new cleartext. We generate a CSPRNG password here and return
   *     it.
   *   - `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` → throw
   *     SupabaseRotationNotSupportedError (Management API does not
   *     expose JWT key rotation; user must use the dashboard).
   *   - any other key → unsupported.
   */
  async rotateChildAccess(access, childProviderRef, accessKey): Promise<string> {
    if (accessKey === 'SUPABASE_SERVICE_ROLE_KEY' || accessKey === 'SUPABASE_ANON_KEY') {
      throw new SupabaseRotationNotSupportedError(
        `supabase-org-admin: ${accessKey} can only be rotated from the Supabase dashboard`,
        SUPABASE_SERVICE_ROLE_ROTATION_FALLBACK_DOCS,
      );
    }
    if (accessKey !== 'SUPABASE_DB_PASSWORD') {
      throw new SupabaseRotationNotSupportedError(
        `supabase-org-admin: cannot rotate access key ${accessKey} (only SUPABASE_DB_PASSWORD supported)`,
        SUPABASE_SERVICE_ROLE_ROTATION_FALLBACK_DOCS,
      );
    }
    if (typeof childProviderRef !== 'string' || childProviderRef.length === 0) {
      throw new Error('supabase-org-admin: rotateChildAccess expects childProviderRef=projectRef');
    }
    const headers = authHeaders(access);
    const newPassword = generateDbPassword();
    const resp = await fetch(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(childProviderRef)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ db_pass: newPassword }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `supabase-org-admin: rotateChildAccess failed (${resp.status} ${resp.statusText}): ${text.slice(0, 200)}`,
      );
    }
    return newPassword;
  },
};

/**
 * Generate a 32-char alphanumeric password suitable for a Supabase
 * Postgres role. Uses `crypto.getRandomValues` which exists in every
 * Phase 6 target runtime (browser + node ≥ 20).
 */
function generateDbPassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}
