/**
 * Barrel for the GitHub provider kinds.
 *
 * Three kinds covering the spec §5.3 hierarchy:
 *   - `github-org`        — read-only org inventory (OrgResourceKind).
 *   - `github-org-admin`  — privileged org credential, manages `github-repo`.
 *   - `github-repo`       — single repo with an admin-mediated deploy token.
 *
 * Aggregation into the global `CATALOG` array happens in
 * `packages/crm-catalog/src/registry.ts` (Phase 3 wave B).
 */

export { githubOrg } from './org.js';
export { githubOrgAdmin } from './org-admin.js';
export { githubRepo } from './repo.js';
