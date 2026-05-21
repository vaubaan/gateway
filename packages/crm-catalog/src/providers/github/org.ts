/**
 * `github-org` — OrgResourceKind, spec §5.1 / §5.3.
 *
 * Read-only inventory of a GitHub organization. The Access bundle carries
 * one fine-grained PAT (`GITHUB_TOKEN`) scoped to a single org, with
 * **read-only** permissions. This kind never provisions anything — its
 * sole purpose is to gate visibility (org membership, repo list, etc.)
 * for downstream MCP tooling and health checks.
 *
 * Rotation is `manual` (spec §0.1): GitHub does not expose an API to
 * regenerate fine-grained PATs programmatically, so the user must rotate
 * via the GitHub UI and paste the new value into the CRM wizard.
 *
 * No `createChild` / `rotateChildAccess` here — provisioning logic lives
 * in `github-org-admin` (and lands behaviourally in Phase 6).
 */

import type { McpServerFragment, ResourceKind } from '../../resource-kind.js';

interface GithubOrgMetadata {
  /** GitHub organization login (slug), e.g. `vauban`. */
  readonly org: string;
}

function isGithubOrgMetadata(value: unknown): value is GithubOrgMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { org?: unknown }).org === 'string' &&
    (value as { org: string }).org.length > 0
  );
}

const SETUP_DOCS = `## Provision a fine-grained PAT for \`github-org\` (read-only)

This Resource holds a **read-only** GitHub Personal Access Token scoped
to a single organization. It is consumed by MCP tooling and by the CRM
health check to verify the org is reachable. It does **not** grant any
write capability — see \`github-org-admin\` for that.

### 1. Open the GitHub PAT settings

Sign in as a member of the target org, then go to
\`https://github.com/settings/personal-access-tokens/new\`. Pick
**Fine-grained personal access token** (do not use a classic PAT — they
cannot be org-scoped).

### 2. Scope the token to the org

- **Resource owner**: select the target organization (not your personal
  account). If the dropdown does not list the org, ask an org owner to
  enable fine-grained PATs in the org's "Personal access tokens"
  settings.
- **Expiration**: pick the shortest expiration you can live with. The
  CRM will warn you before it lapses. 90 days is a sane default.
- **Repository access**: \`All repositories\` if you want full
  inventory, otherwise the explicit set you need.

### 3. Pick the read-only permissions

Under **Permissions → Repository permissions**:

- \`Metadata\`: **Read-only** (mandatory).
- \`Contents\`: **Read-only** (optional, lets MCP browse code).
- \`Issues\`: **Read-only** (optional).
- \`Pull requests\`: **Read-only** (optional).

Under **Permissions → Organization permissions**:

- \`Members\`: **Read-only** (optional, lets MCP list teammates).

Leave every other permission at \`No access\`. **Do not** grant any
\`Read and write\` permission here — that's what \`github-org-admin\`
is for.

### 4. Generate and paste

Click **Generate token** and copy the value (starts with
\`github_pat_\`). Paste it into the CRM wizard as \`GITHUB_TOKEN\`. The
CRM seals it client-side before it ever hits the network — no
cleartext is persisted (spec §2.3 / §4).

### Rotation

Fine-grained PATs cannot be rotated via API. To rotate, repeat steps
1–4 with the same scopes and paste the new value into the CRM
"Rotate Access" flow. The CRM will re-seal it for the same recipient
set.
`;

export const githubOrg: ResourceKind = {
  id: 'github-org',
  provider: 'github',
  kindClass: 'org',
  displayName: 'GitHub organization',
  setupDocs: SETUP_DOCS,
  accessSchema: {
    GITHUB_TOKEN: {
      label: 'Fine-grained PAT (read-only, org-scoped)',
      description:
        'GitHub fine-grained personal access token, resource-owner = the target org, ' +
        'read-only permissions only. Starts with `github_pat_`.',
      required: true,
      pattern: '^github_pat_[A-Za-z0-9_]{20,}$',
    },
  },
  metadataSchema: {
    description: 'GithubOrgMetadata: { org: string }',
    fields: { org: { type: 'string', required: true } },
  },
  rotationMethod: 'manual',
  healthTestCmd(metadata, _access): string {
    if (!isGithubOrgMetadata(metadata)) {
      throw new Error('github-org: invalid metadata, expected { org: string }');
    }
    // The command reads $GITHUB_TOKEN from the Runner-injected env (spec
    // §10); we never embed the cleartext into the command string itself.
    return (
      `curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" ` +
      `"https://api.github.com/orgs/${metadata.org}" | jq -e .login >/dev/null`
    );
  },
  mcpFragment(metadata): McpServerFragment | null {
    if (!isGithubOrgMetadata(metadata)) {
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
};
