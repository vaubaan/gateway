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
 * The provider operations (`createChild`, `destroyChild`,
 * `rotateChildAccess`, `listChildren`) are intentionally **stubs** in
 * this phase — the contract shape is locked in, but the actual
 * GitHub API calls land in Phase 6 (provisioning). Any caller that
 * invokes these methods today gets a `phase-6: not implemented` error
 * so we fail loudly instead of silently no-op'ing.
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

function notYetImplemented(method: string): Promise<never> {
  // Phase 6 will replace these stubs with actual `@octokit/rest` calls.
  // We reject with a stable error code so callers can recognise it.
  return Promise.reject(new Error(`phase-6: ${method} not implemented (github-org-admin)`));
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
