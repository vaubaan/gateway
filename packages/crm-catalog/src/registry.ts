/**
 * Catalogue registry — spec §5.3 / §6.1.
 *
 * Single source of truth for the list of `ResourceKind`s known to the
 * CRM. Provider barrels live under `./providers/<name>/` and export
 * their kinds; this module aggregates them into a frozen `CATALOG`
 * array plus a `findKind(id)` helper.
 *
 * v1 inventory (9 kinds):
 *   - github:         github-org, github-org-admin, github-repo
 *   - vercel:         vercel-team, vercel-team-admin, vercel-project
 *   - supabase-cloud: supabase-org, supabase-org-admin, supabase-project
 *
 * Structural invariants enforced by `tests/unit/registry.test.ts`
 * (spec §12.4):
 *   - All `id` values are unique.
 *   - Every `kindClass: 'org-admin'` declares a non-empty `manages: [...]`.
 *   - Every `rotationMethod` ∈ `{self, admin-mediated, manual}`.
 */

import * as github from './providers/github/index.js';
import * as supabaseCloud from './providers/supabase-cloud/index.js';
import * as vercel from './providers/vercel/index.js';
import type { ResourceKind } from './resource-kind.js';

/**
 * Frozen, ordered list of all `ResourceKind`s shipped in v1.
 *
 * The ordering (provider-major, kindClass-minor: org → org-admin →
 * project) matches the layout of the "+ Add Resource" wizard and the
 * `GET /api/crm/v1/catalog` response.
 */
export const CATALOG: readonly ResourceKind[] = Object.freeze([
  github.githubOrg,
  github.githubOrgAdmin,
  github.githubRepo,
  vercel.vercelTeam,
  vercel.vercelTeamAdmin,
  vercel.vercelProject,
  supabaseCloud.supabaseOrg,
  supabaseCloud.supabaseOrgAdmin,
  supabaseCloud.supabaseProject,
]);

/**
 * Look up a `ResourceKind` by its `id`. Returns `undefined` when no
 * match exists — callers must handle the 404 path explicitly (the
 * REST endpoint does this in `route.ts`).
 */
export function findKind(id: string): ResourceKind | undefined {
  return CATALOG.find((k) => k.id === id);
}
