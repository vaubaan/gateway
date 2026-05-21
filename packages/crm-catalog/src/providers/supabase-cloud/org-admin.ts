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

function notYetImplemented(method: string): Promise<never> {
  return Promise.reject(new Error(`phase-6: ${method} not implemented (supabase-org-admin)`));
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
  listChildren(_access): Promise<readonly ProviderChild[]> {
    return notYetImplemented('listChildren');
  },
  createChild(_access, _spec): Promise<ProviderChild> {
    return notYetImplemented('createChild');
  },
  destroyChild(_access, _providerRef): Promise<void> {
    return notYetImplemented('destroyChild');
  },
  rotateChildAccess(_access, _childProviderRef, _accessKey): Promise<string> {
    return notYetImplemented('rotateChildAccess');
  },
};
