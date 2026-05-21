/**
 * `supabase-org` — OrgResourceKind, spec §5.1 / §5.3.
 *
 * Read-side credential for a Supabase organization. The Access bundle
 * carries a user **Personal Access Token (PAT)** scoped to the user's
 * Supabase account; access to org-level metadata is granted through
 * the user's membership in the org (Supabase Cloud doesn't expose
 * org-scoped tokens — the API filters by `organization_id` and the
 * caller must belong to the org).
 *
 * Rotation is `manual` (spec §0.1): Supabase Cloud does not expose a
 * stable rotation API for PATs. The user regenerates manually via
 * `https://supabase.com/dashboard/account/tokens` and pastes the new
 * value into the CRM "Rotate Access" flow.
 *
 * MCP integration: Supabase ships an npx-driven stdio MCP server
 * (`@supabase/mcp-server-supabase`, cf. `.mcp.json` racine). The
 * fragment emitted here mirrors that shape — the PAT is passed via
 * `--access-token` from the sealed Access bundle.
 */

import type { McpServerFragment, ResourceKind } from '../../resource-kind.js';

interface SupabaseOrgMetadata {
  /** Supabase organization slug (URL-friendly, e.g. `vauban`). */
  readonly orgSlug: string;
}

function isSupabaseOrgMetadata(value: unknown): value is SupabaseOrgMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { orgSlug?: unknown }).orgSlug === 'string' &&
    (value as { orgSlug: string }).orgSlug.length > 0
  );
}

const SETUP_DOCS = `## Provision a Supabase Personal Access Token for \`supabase-org\`

This Resource holds a Supabase **Personal Access Token (PAT)**, used
to read the org-level inventory (projects, members, billing tier).
Supabase Cloud filters API responses by the caller's organization
membership — the token itself is user-scoped, not org-scoped.

### 1. Create the PAT

1. Sign in to \`https://supabase.com\` as a member of the target
   organization.
2. Open \`https://supabase.com/dashboard/account/tokens\`.
3. Click **Generate new token**:
   - **Name**: \`crm-supabase-org-<your-org-slug>\` (any descriptive
     value).
   - There is no per-org scope dropdown — the API simply filters
     by the orgs you belong to. If you belong to multiple orgs and
     want strict isolation, use a dedicated Supabase account.
4. Copy the token value. You **will not** be able to see it again.

### 2. Find the organization slug

The Supabase API addresses orgs by their stable slug (the part after
\`/dashboard/\` in the URL when you're on the org overview page —
e.g. \`vauban\`). Verify via:

\`\`\`sh
curl -fsS -H "Authorization: Bearer <YOUR_TOKEN>" \\
  https://api.supabase.com/v1/organizations | jq '.[] | {id,slug,name}'
\`\`\`

Pick the \`slug\` of the org you scoped this token to.

### 3. Paste into the CRM wizard

- \`SUPABASE_ACCESS_TOKEN\`: the PAT value from step 1.

The CRM seals it client-side (spec §4). Cleartext never reaches the
server.

### Rotation

Regenerate via the Supabase dashboard (revoke the old token, generate
a new one) and paste the new value into the CRM "Rotate Access" flow.
The org slug is stable across rotations.
`;

export const supabaseOrg: ResourceKind = {
  id: 'supabase-org',
  provider: 'supabase-cloud',
  kindClass: 'org',
  displayName: 'Supabase organization',
  setupDocs: SETUP_DOCS,
  accessSchema: {
    SUPABASE_ACCESS_TOKEN: {
      label: 'Supabase Personal Access Token',
      description:
        'PAT issued via supabase.com/dashboard/account/tokens. Scoped to your ' +
        'user account; the org context comes from your membership. Used by the ' +
        'Supabase MCP server and by HTTP/CLI tooling.',
      required: true,
      pattern: '^sbp_[A-Za-z0-9]{20,}$',
    },
  },
  metadataSchema: {
    description: 'SupabaseOrgMetadata: { orgSlug: string }',
    fields: { orgSlug: { type: 'string', required: true } },
  },
  rotationMethod: 'manual',
  healthTestCmd(metadata, _access): string {
    if (!isSupabaseOrgMetadata(metadata)) {
      throw new Error('supabase-org: invalid metadata, expected { orgSlug: string }');
    }
    // Hit /v1/organizations and filter by slug — passes iff the token
    // is valid AND the caller is a member of the target org.
    return (
      `curl -fsS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" ` +
      `https://api.supabase.com/v1/organizations | ` +
      `jq -e '.[] | select(.slug == "${metadata.orgSlug}") | .id' >/dev/null`
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
};
