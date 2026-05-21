/**
 * Barrel for the Vercel provider kinds.
 *
 * Three kinds covering the spec §5.3 hierarchy:
 *   - `vercel-team`        — read-only team inventory (OrgResourceKind).
 *   - `vercel-team-admin`  — privileged team credential, manages `vercel-project`.
 *   - `vercel-project`     — single project with an admin-mediated token.
 *
 * Aggregation into the global `CATALOG` array happens in
 * `packages/crm-catalog/src/registry.ts` (Phase 3 wave B).
 */

export { vercelTeam } from './team.js';
export { vercelTeamAdmin } from './team-admin.js';
export { vercelProject } from './project.js';
