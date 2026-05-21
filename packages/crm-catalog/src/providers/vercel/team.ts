/**
 * `vercel-team` — OrgResourceKind, spec §5.1 / §5.3.
 *
 * Read-side credential for a Vercel team. The Access bundle carries a
 * team-scoped Vercel token (`VERCEL_TOKEN`) together with the team's
 * stable identifier (`VERCEL_TEAM_ID`). Used by MCP tooling and by the
 * health check to verify the team is reachable.
 *
 * Rotation is `manual` (spec §0.1): Vercel does not expose a stable
 * public API to regenerate access tokens programmatically — the user
 * must regenerate via the Vercel dashboard and paste the new value
 * into the CRM rotation flow.
 *
 * MCP integration: Vercel ships an OAuth-backed remote MCP endpoint
 * (`https://mcp.vercel.com/`, type=`http`) — cf. `.mcp.json` at the
 * repo root. The fragment emitted here mirrors that shape (no static
 * token in the MCP env; auth happens at the OAuth handshake in the
 * MCP client).
 */

import type { McpServerFragment, ResourceKind } from '../../resource-kind.js';

interface VercelTeamMetadata {
  /** Vercel team slug (URL-friendly, e.g. `vauban`). */
  readonly teamSlug: string;
}

function isVercelTeamMetadata(value: unknown): value is VercelTeamMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { teamSlug?: unknown }).teamSlug === 'string' &&
    (value as { teamSlug: string }).teamSlug.length > 0
  );
}

const SETUP_DOCS = `## Provision a Vercel access token for \`vercel-team\`

This Resource holds a **team-scoped** Vercel access token, used to
inventory and query a single Vercel team. It is consumed by the
health check and (when an HTTP/CLI tool needs static auth) by
Runner-injected env vars.

For the MCP integration itself, Vercel exposes a remote
OAuth-backed MCP endpoint at \`https://mcp.vercel.com/\` — the
\`VERCEL_TOKEN\` below is **not** used by MCP. The MCP client
handles OAuth interactively the first time it connects.

### 1. Create a team-scoped access token

1. Sign in to \`https://vercel.com\` as a member of the target team.
2. Open \`https://vercel.com/account/tokens\` (this URL is global
   per-user; the *scope* is what makes the token team-scoped).
3. Click **Create Token**:
   - **Token Name**: \`crm-vercel-team-<your-team-slug>\` (any
     descriptive value).
   - **Scope**: pick the target team (not "Full Account" — we want
     team-scoped).
   - **Expiration**: shortest acceptable. The CRM warns you ahead
     of expiry. 90 days is a sane default.
4. Click **Create**, then **copy** the token value. You will not be
   able to see it again — paste it into the CRM wizard immediately.

### 2. Find the team identifier

The Vercel API uses an opaque \`team_id\` (looks like
\`team_xxxxxxxxxxxxxxxx\`). Find yours via:

\`\`\`sh
curl -fsS -H "Authorization: Bearer <YOUR_TOKEN>" \\
  https://api.vercel.com/v2/teams | jq '.teams[] | {id,slug}'
\`\`\`

Pick the \`id\` matching the team slug you scoped the token to.

### 3. Paste into the CRM wizard

- \`VERCEL_TOKEN\`: the token value from step 1.
- \`VERCEL_TEAM_ID\`: the \`team_xxx\` identifier from step 2.

The CRM seals both client-side (spec §4). Cleartext never leaves the
browser.

### Rotation

Regenerate via the Vercel dashboard (delete the old token, create a
new one with the same scope) and paste the new value into the CRM
"Rotate Access" flow. The team id is stable across rotations.
`;

export const vercelTeam: ResourceKind = {
  id: 'vercel-team',
  provider: 'vercel',
  kindClass: 'org',
  displayName: 'Vercel team',
  setupDocs: SETUP_DOCS,
  accessSchema: {
    VERCEL_TOKEN: {
      label: 'Team-scoped Vercel access token',
      description:
        'Vercel access token issued via vercel.com/account/tokens, scoped to ' +
        'a single team. Used by HTTP/CLI tools (the MCP integration is OAuth, ' +
        'not token-based).',
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
    description: 'VercelTeamMetadata: { teamSlug: string }',
    fields: { teamSlug: { type: 'string', required: true } },
  },
  rotationMethod: 'manual',
  healthTestCmd(metadata, _access): string {
    if (!isVercelTeamMetadata(metadata)) {
      throw new Error('vercel-team: invalid metadata, expected { teamSlug: string }');
    }
    return (
      `curl -fsS -H "Authorization: Bearer $VERCEL_TOKEN" ` +
      `"https://api.vercel.com/v2/teams/${metadata.teamSlug}" | jq -e .id >/dev/null`
    );
  },
  mcpFragment(_metadata): McpServerFragment | null {
    // Vercel uses a remote OAuth-backed MCP server (cf. .mcp.json root).
    // The shape is `{ type: 'http', url }` — no static token, the MCP
    // client negotiates OAuth on first connect.
    return {
      type: 'http',
      url: 'https://mcp.vercel.com/',
    };
  },
  egressHosts(_metadata): readonly string[] {
    return ['api.vercel.com', 'vercel.com', 'mcp.vercel.com'];
  },
};
