/**
 * Vercel classifier — maps a concrete (tool, args) call to the capability it
 * requires, in Vercel-native semantics.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §3, §6.
 *
 * Vercel exposes the `runtime` plane with the ladder (interne → externe) :
 *
 *   niv1 `deployment`        — the served build + runtime logs
 *   niv2 `config`            — env vars, build settings
 *   niv3 `project-settings`  — domains, deployment protection
 *   niv4 `account`           — project, team, tokens
 *
 * Env on `deployment` / `config` = args.target normalized to 'prod' | 'preview'
 * | 'development' (default 'prod' when absent — conservative).
 */

import type { Capability, ProviderBinding } from '@vaubaan/shared';

export type ClassifyResult = { capability: Capability } | { denied: string };

type Kind =
  | 'read-account'
  | 'read-project-settings'
  | 'read-deployment'
  | 'write-deployment'
  | 'write-deployment-targeted'
  | 'write-config-targeted'
  | 'write-project-settings';

const TOOL_KIND: Record<string, Kind> = {
  // Account-level reads
  vercel__search_vercel_documentation: 'read-account',
  vercel__list_projects: 'read-account',
  vercel__list_teams: 'read-account',
  // Project-settings reads
  vercel__get_project: 'read-project-settings',
  vercel__check_domain_availability_and_price: 'read-project-settings',
  // Deployment reads
  vercel__list_deployments: 'read-deployment',
  vercel__get_deployment: 'read-deployment',
  vercel__get_deployment_build_logs: 'read-deployment',
  vercel__get_runtime_logs: 'read-deployment',
  vercel__get_access_to_vercel_url: 'read-deployment',
  vercel__web_fetch_vercel_url: 'read-deployment',
  vercel__list_toolbar_threads: 'read-deployment',
  vercel__get_toolbar_thread: 'read-deployment',
  // Toolbar writes — feedback comments on a deployment.
  vercel__change_toolbar_thread_resolve_status: 'write-deployment',
  vercel__reply_to_toolbar_thread: 'write-deployment',
  vercel__edit_toolbar_message: 'write-deployment',
  vercel__add_toolbar_reaction: 'write-deployment',
  // Real writes
  vercel__deploy_to_vercel: 'write-deployment-targeted',
  vercel__upsert_env_var: 'write-config-targeted',
  vercel__update_project_settings: 'write-project-settings',
};

function cap(level: string, action: 'read' | 'write', env?: string): Capability {
  return env
    ? { provider: 'vercel', plane: 'runtime', level, action, env }
    : { provider: 'vercel', plane: 'runtime', level, action };
}

/** Map a Vercel `target` arg to a Vaubaan env slug. Absent → 'prod' (conservative). */
function envOf(target: unknown): string {
  if (target === 'preview') return 'preview';
  if (target === 'development') return 'development';
  return 'prod';
}

/** Env-less capability surface of a tool — used by the static tools/list filter. */
export function vercelToolCapabilities(tool: string): readonly Capability[] {
  const kind = TOOL_KIND[tool];
  if (!kind) return [];
  switch (kind) {
    case 'read-account':
      return [cap('account', 'read')];
    case 'read-project-settings':
      return [cap('project-settings', 'read')];
    case 'read-deployment':
      return [cap('deployment', 'read')];
    case 'write-deployment':
    case 'write-deployment-targeted':
      return [cap('deployment', 'write')];
    case 'write-config-targeted':
      return [cap('config', 'write')];
    case 'write-project-settings':
      return [cap('project-settings', 'write')];
  }
}

function boundProjects(bindings: ReadonlyArray<ProviderBinding>): string[] {
  return bindings.filter((b) => b.provider === 'vercel').map((b) => b.resource_ref);
}

export function classifyVercel(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const kind = TOOL_KIND[tool];
  if (!kind) return { denied: `unknown vercel tool '${tool}'.` };

  // Binding check : if the call carries a projectId, it must be bound. When
  // absent, scope-injection fills it from the single binding (don't fail here).
  // Account-level reads never carry one.
  const projectId = args.projectId ?? args.project_id;
  if (typeof projectId === 'string') {
    if (!boundProjects(bindings).includes(projectId)) {
      return { denied: `vercel project '${projectId}' is not bound to this project.` };
    }
  }

  switch (kind) {
    case 'read-account':
      return { capability: cap('account', 'read') };
    case 'read-project-settings':
      return { capability: cap('project-settings', 'read') };
    case 'read-deployment':
      return { capability: cap('deployment', 'read') };
    case 'write-deployment':
      return { capability: cap('deployment', 'write') };
    case 'write-deployment-targeted':
      return { capability: cap('deployment', 'write', envOf(args.target)) };
    case 'write-config-targeted':
      return { capability: cap('config', 'write', envOf(args.target)) };
    case 'write-project-settings':
      return { capability: cap('project-settings', 'write') };
  }
}
