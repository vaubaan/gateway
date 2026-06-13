/**
 * Railway classifier — maps a concrete (tool, args) call to the capability it
 * requires, in Railway-native semantics.
 *
 * Spec : docs/spec/gateway-capability-model.md §3, §6.
 *
 * Railway exposes the `runtime` plane with the ladder (interne → externe) :
 *
 *   niv1 `deployment`        — services, deployments, logs
 *   niv2 `config`            — service vars (not in MVP)
 *   niv3 `project-settings`  — project config (not in MVP)
 *   niv4 `account`           — account, projects, tokens
 *
 * ENV : same model as Supabase — one Railway project per env. The binding's
 * `environment` column carries the env slug ; tools scoped to a specific
 * Railway project stamp that env on the resolved capability. Account-level
 * tools (whoami, list-projects, create-project, railway-agent) are
 * inherently env-less : they don't target a single Railway project.
 */

import type { Capability, EnvResolution, ProviderBinding } from '@vaubaan/shared';

export type ClassifyResult = { capability: Capability } | { denied: string };

type Kind =
  | 'read-account'
  | 'read-deployment'
  | 'write-deployment'
  | 'write-account'
  | 'read-config'
  | 'write-config';

const TOOL_KIND: Record<string, Kind> = {
  railway__whoami: 'read-account',
  'railway__list-projects': 'read-account',
  'railway__list-services': 'read-deployment',
  'railway__list-deployments': 'read-deployment',
  'railway__get-status': 'read-deployment',
  'railway__get-logs': 'read-deployment',
  railway__redeploy: 'write-deployment',
  'railway__accept-deploy': 'write-deployment',
  'railway__railway-agent': 'write-deployment',
  'railway__create-project': 'write-account',
  // Custom GraphQL env-var tools — runtime/config (cf. custom-tools.ts).
  'railway__list-variables': 'read-config',
  'railway__upsert-variable': 'write-config',
  'railway__upsert-variables': 'write-config',
  'railway__delete-variable': 'write-config',
};

/** Tools whose env is resolved from the matched binding at call time. Their
 *  static surface is env-less (any env-qualified grant on the right plane is a
 *  potential match) ; the binding-bound env is stamped at classify time. */
const ENV_FROM_BINDING: ReadonlySet<string> = new Set([
  'railway__list-services',
  'railway__list-deployments',
  'railway__get-status',
  'railway__get-logs',
  'railway__redeploy',
  'railway__accept-deploy',
  'railway__list-variables',
  'railway__upsert-variable',
  'railway__upsert-variables',
  'railway__delete-variable',
]);

function cap(level: string, action: 'read' | 'write', env?: string): Capability {
  return env
    ? { provider: 'railway', plane: 'runtime', level, action, env }
    : { provider: 'railway', plane: 'runtime', level, action };
}

const KIND_SURFACE: Record<Kind, Capability> = {
  'read-account': cap('account', 'read'),
  'read-deployment': cap('deployment', 'read'),
  'write-deployment': cap('deployment', 'write'),
  'write-account': cap('account', 'write'),
  'read-config': cap('config', 'read'),
  'write-config': cap('config', 'write'),
};

/** Env-less capability surface of a tool, for static tools/list filtering. */
export function railwayToolCapabilities(tool: string): readonly Capability[] {
  const kind = TOOL_KIND[tool];
  return kind ? [KIND_SURFACE[kind]] : [];
}

/** How env is determined at `tools/call` time. Project-scoped tools resolve
 *  env from the matched binding (one Railway project per env) → `runtime`.
 *  Account-level and unknown tools → `static` (env-less). */
export function railwayToolEnvResolution(tool: string): EnvResolution {
  return ENV_FROM_BINDING.has(tool) ? 'runtime' : 'static';
}

function railwayBindings(bindings: ReadonlyArray<ProviderBinding>): ProviderBinding[] {
  return bindings.filter((b) => b.provider === 'railway');
}

/** The Railway project id carried by the call, if any (both arg spellings). */
function targetProjectId(args: Record<string, unknown>): string | undefined {
  if (typeof args.projectId === 'string') return args.projectId;
  if (typeof args.project_id === 'string') return args.project_id;
  return undefined;
}

export function classifyRailway(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const kind = TOOL_KIND[tool];
  if (!kind) return { denied: `unknown railway tool '${tool}'.` };

  // Account-level tools : no binding lookup, no env resolution.
  if (!ENV_FROM_BINDING.has(tool)) {
    return { capability: KIND_SURFACE[kind] };
  }

  // Project-scoped tools : resolve binding (explicit arg wins ; single binding
  // unambiguously fills in via scope injection — replicated here so the unit
  // surface mirrors the runtime contract).
  const all = railwayBindings(bindings);
  let projectId = targetProjectId(args);
  if (projectId === undefined) {
    if (all.length === 1) {
      projectId = all[0]!.resource_ref;
    } else {
      return { denied: 'ambiguous railway target: specify projectId.' };
    }
  }

  const binding = all.find((b) => b.resource_ref === projectId);
  if (!binding) {
    return { denied: `railway project '${projectId}' is not bound to this project.` };
  }
  const env = binding.environment ?? undefined;

  const base = KIND_SURFACE[kind];
  return { capability: cap(base.level, base.action, env) };
}
