/**
 * `vercel-project` — ProjectResourceKind, spec §5.1 / §5.3.
 *
 * A single Vercel project owned by a `vercel-team-admin`. The Access
 * bundle carries the team-scoped token (inherited from the admin's
 * provisioning op), the team id, and the project id.
 *
 * Rotation is `admin-mediated` (spec §0.1): the project-bound token
 * is rotated by the managing `vercel-team-admin` via the Vercel API,
 * not by the user. The CRM "Rotate Access" flow detects this and
 * routes the request through the parent admin Resource (Phase 6).
 *
 * No `mcpFragment` for this kind — Vercel MCP is account-wide and is
 * wired at the team-level kinds. Per-project MCP would require a
 * dedicated context root, which Vercel doesn't expose.
 */

import type { ResourceKind } from '../../resource-kind.js';

interface VercelProjectMetadata {
  readonly teamSlug: string;
  readonly projectSlug: string;
}

function isVercelProjectMetadata(value: unknown): value is VercelProjectMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { teamSlug?: unknown; projectSlug?: unknown };
  return (
    typeof v.teamSlug === 'string' &&
    v.teamSlug.length > 0 &&
    typeof v.projectSlug === 'string' &&
    v.projectSlug.length > 0
  );
}

const SETUP_DOCS = `## \`vercel-project\` is admin-managed

You do **not** provision this Resource by pasting tokens. A
\`vercel-project\` is always created and rotated by its managing
\`vercel-team-admin\` Resource — see spec §0.1 (\`admin-mediated\`
rotation) and §5.3.

### How to add a vercel-project to the CRM

1. Make sure your team already has a \`vercel-team-admin\` Resource
   registered. If not, follow the \`vercel-team-admin\` setup first.
2. Open the CRM "+ Add Resource" wizard, pick \`vercel-project\`,
   and select the managing admin from the dropdown.
3. Choose **Create new** (the admin creates a fresh Vercel project
   via the API) or **Adopt existing** (the admin inventories an
   existing project and re-issues a fresh project-scoped token).
4. The CRM seals the resulting bundle client-side (spec §4) under
   \`(resourceId, VERCEL_TOKEN)\`, \`(resourceId, VERCEL_TEAM_ID)\`,
   and \`(resourceId, VERCEL_PROJECT_ID)\`. Cleartext never reaches
   the server.

### What these credentials can do

- \`VERCEL_TOKEN\`: team-scoped access token bound to this project's
  managing admin. Used by CI / runners to deploy, list deployments,
  read env vars, etc.
- \`VERCEL_TEAM_ID\` and \`VERCEL_PROJECT_ID\`: stable identifiers
  the Vercel API requires on every call. They are not secrets in
  the strict sense but they live in the same sealed bundle so the
  Runner gets them as a single unit.

### Rotation

Open the CRM resource page → "Rotate Access". The request is
dispatched to the managing \`vercel-team-admin\`, which regenerates
the project's scoped token via the Vercel Access Tokens API. The
new value is sealed for the same recipient set; the old value
becomes invalid within seconds.

### What if my managing admin is detached?

A \`vercel-project\` with no live \`admin_resource_id\` link (spec
§3.3) cannot be rotated. The CRM surfaces a 409 with
\`rotationMethod=admin-mediated\` and a "Re-attach an admin" CTA.
Re-attach by editing the Resource and picking another live
\`vercel-team-admin\` from the same team.
`;

export const vercelProject: ResourceKind = {
  id: 'vercel-project',
  provider: 'vercel',
  kindClass: 'project',
  displayName: 'Vercel project',
  setupDocs: SETUP_DOCS,
  accessSchema: {
    VERCEL_TOKEN: {
      label: 'Project-scoped Vercel access token',
      description:
        'Team-scoped Vercel access token issued and rotated by the managing ' +
        '`vercel-team-admin`. The CRM "+ Add Resource" wizard fills this for ' +
        'you — you do not paste it manually.',
      required: true,
      pattern: '^[A-Za-z0-9]{24,}$',
    },
    VERCEL_TEAM_ID: {
      label: 'Vercel team id',
      description: 'Opaque team identifier (looks like `team_xxxxxxxxxxxxxxxx`).',
      required: true,
      pattern: '^team_[A-Za-z0-9]{10,}$',
    },
    VERCEL_PROJECT_ID: {
      label: 'Vercel project id',
      description: 'Opaque project identifier (looks like `prj_xxxxxxxxxxxxxxxx`).',
      required: true,
      pattern: '^prj_[A-Za-z0-9]{10,}$',
    },
  },
  metadataSchema: {
    description: 'VercelProjectMetadata: { teamSlug: string, projectSlug: string }',
    fields: {
      teamSlug: { type: 'string', required: true },
      projectSlug: { type: 'string', required: true },
    },
  },
  rotationMethod: 'admin-mediated',
  healthTestCmd(metadata, _access): string {
    if (!isVercelProjectMetadata(metadata)) {
      throw new Error('vercel-project: invalid metadata, expected { teamSlug, projectSlug }');
    }
    return (
      `curl -fsS -H "Authorization: Bearer $VERCEL_TOKEN" ` +
      `"https://api.vercel.com/v9/projects/${metadata.projectSlug}?teamId=$VERCEL_TEAM_ID" ` +
      `| jq -e .id >/dev/null`
    );
  },
  egressHosts(_metadata): readonly string[] {
    return ['api.vercel.com', 'vercel.com'];
  },
};
