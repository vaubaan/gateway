/**
 * Barrel for the Supabase Cloud provider kinds.
 *
 * Three kinds covering the spec §5.3 hierarchy:
 *   - `supabase-org`        — read-only org inventory (OrgResourceKind).
 *   - `supabase-org-admin`  — privileged org credential, manages `supabase-project`.
 *   - `supabase-project`    — single project with admin-mediated cred rotation.
 *
 * Aggregation into the global `CATALOG` array happens in
 * `packages/crm-catalog/src/registry.ts` (Phase 3 wave B).
 */

export { supabaseOrg } from './org.js';
export { supabaseOrgAdmin } from './org-admin.js';
export { supabaseProject } from './project.js';
