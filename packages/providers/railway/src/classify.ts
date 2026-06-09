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
 * ENV : Railway "environments" need an upstream name lookup to resolve, which
 * the MVP does NOT do (no stateful upstream calls in the classifier). So `env`
 * is left undefined on every capability here. When env resolution lands, it
 * will be wired from the matched binding / args, not invented.
 */

import type { Capability, ProviderBinding } from '@vaubaan/shared';

export type ClassifyResult = { capability: Capability } | { denied: string };

type Kind = 'read-account' | 'read-deployment' | 'write-deployment' | 'write-account';

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
};

function cap(level: string, action: 'read' | 'write'): Capability {
  // env intentionally omitted — see file header.
  return { provider: 'railway', plane: 'runtime', level, action };
}

const KIND_SURFACE: Record<Kind, Capability> = {
  'read-account': cap('account', 'read'),
  'read-deployment': cap('deployment', 'read'),
  'write-deployment': cap('deployment', 'write'),
  'write-account': cap('account', 'write'),
};

/** Env-less capability surface of a tool, for static tools/list filtering. */
export function railwayToolCapabilities(tool: string): readonly Capability[] {
  const kind = TOOL_KIND[tool];
  return kind ? [KIND_SURFACE[kind]] : [];
}

function boundProjects(bindings: ReadonlyArray<ProviderBinding>): string[] {
  return bindings.filter((b) => b.provider === 'railway').map((b) => b.resource_ref);
}

export function classifyRailway(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const kind = TOOL_KIND[tool];
  if (!kind) return { denied: `unknown railway tool '${tool}'.` };

  // Binding check : project-scoped calls carry the projectId as `projectId` or
  // `project_id`. When present it MUST be bound to this project. When absent we
  // do NOT fail — scope-injection fills the projectId for single-binding
  // projects, and account-level tools (whoami, list-projects, create-project,
  // railway-agent) never carry one.
  const projectId =
    typeof args.projectId === 'string'
      ? args.projectId
      : typeof args.project_id === 'string'
        ? args.project_id
        : undefined;
  if (projectId !== undefined) {
    const projects = boundProjects(bindings);
    if (!projects.includes(projectId)) {
      return { denied: `railway project '${projectId}' is not bound to this project.` };
    }
  }

  return { capability: KIND_SURFACE[kind] };
}
