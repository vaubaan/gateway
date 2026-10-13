/**
 * Classifier of the `railway` provider : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3 (slice DSL), §7 (plugin contract) ;
 *            docs/spec/vaubaan-gateway.md §10 ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/railway.md.
 *
 * Pure : no IO, no credential, no `Date`. Every tool maps to at least one
 * slice ; a call the plugin cannot place on the data model is `denied`
 * (never silently mapped to a broad slice).
 *
 * Conventions :
 *   - The resource is the Railway **project** (UUID). Project-scoped tools
 *     take `projectId` explicitly ; when absent, the classifier falls back to
 *     the mission's single Railway project, or to the project whose
 *     discovered environments contain the `environmentId` argument
 *     (`accept-deploy` carries no `projectId`). Anything else is ambiguous
 *     and denied.
 *   - The `environment[...]` segment carries the **owner label** of the
 *     project (`prod`, `staging`…), so env-qualified risks resolve ; an
 *     unlabelled project yields a wildcard segment.
 *   - Identifiers embedded in a slice (`serviceId`, variable names) are
 *     validated against a safe character class ; a malformed one is denied.
 *
 * Crucial cases :
 *   1. `railway__upsert-variables` is the only tool whose *argument content*
 *      changes the slice shape : `replace: true` → `service-var[*].W`
 *      (matches the destructive `railway.bulk-variables-replace`) ;
 *      otherwise → `service-var[K1,K2,…].W` (matches `railway.upsert-variable`
 *      only). An empty or malformed payload falls back to the wildcard
 *      (pessimistic).
 *   2. `railway__railway-agent` is an opaque meta-tool. Three slices are
 *      emitted in parallel so the mission must accept the union of what the
 *      agent could touch : `account[*].agent-session.W`, the deployment
 *      catch-all and the variable catch-all of the project.
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

export const PROVIDER = 'railway';

/** Identifier chars a slice segment accepts ; anything else is refused rather than escaped. */
const SAFE_IDENT = /^[a-zA-Z0-9_./~-]+$/;

// ─────────────────────────────────────────────────────────────────────────────
// Tool table
// ─────────────────────────────────────────────────────────────────────────────

type Kind =
  | 'read-account-bare' // whoami
  | 'read-account-projects' // list-projects
  | 'write-create-project' // create-project
  | 'read-runtime-services' // list-services
  | 'read-runtime-deployments' // list-deployments
  | 'read-runtime-status' // get-status
  | 'read-runtime-logs' // get-logs
  | 'write-deploy' // redeploy, accept-deploy
  | 'write-agent' // railway-agent (meta-tool)
  | 'read-variables' // list-variables
  | 'write-variable' // upsert-variable, delete-variable
  | 'write-variables-bulk'; // upsert-variables (replace=true OR replace=false)

const TOOL_KIND: Readonly<Record<string, Kind>> = {
  railway__whoami: 'read-account-bare',
  'railway__list-projects': 'read-account-projects',
  'railway__create-project': 'write-create-project',
  'railway__list-services': 'read-runtime-services',
  'railway__list-deployments': 'read-runtime-deployments',
  'railway__get-status': 'read-runtime-status',
  'railway__get-logs': 'read-runtime-logs',
  railway__redeploy: 'write-deploy',
  'railway__accept-deploy': 'write-deploy',
  'railway__railway-agent': 'write-agent',
  'railway__list-variables': 'read-variables',
  'railway__upsert-variable': 'write-variable',
  'railway__delete-variable': 'write-variable',
  'railway__upsert-variables': 'write-variables-bulk',
};

const ACCOUNT_ONLY: ReadonlySet<Kind> = new Set<Kind>([
  'read-account-bare',
  'read-account-projects',
  'write-create-project',
]);

/** True when the tool needs a Railway project resource to be classified. */
export function isProjectScopedTool(tool: string): boolean {
  const kind = TOOL_KIND[tool];
  return kind !== undefined && !ACCOUNT_ONLY.has(kind);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export function classifyRailway(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const kind = TOOL_KIND[tool];
  if (!kind) return { denied: `unknown railway tool '${tool}'.` };

  if (ACCOUNT_ONLY.has(kind)) return { slices: classifyAccountOnly(kind) };

  const project = resolveProject(args, resources);
  if ('denied' in project) return project;

  const service = serviceSegment(args);
  if ('denied' in service) return service;

  return classifyProjectScoped(kind, args, project.ref, project.env, service.segment);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource resolution
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedProject {
  readonly ref: string;
  readonly env: string | null;
}

/** `{ id, name }` pairs the discovery stores under `metadata.environments`. */
export interface RailwayEnvironmentRef {
  readonly id: string;
  readonly name: string;
}

/** Read the discovered Railway environments of a project resource (empty when absent or malformed). */
export function environmentsOf(resource: Resource): readonly RailwayEnvironmentRef[] {
  const raw = resource.metadata?.environments;
  if (!Array.isArray(raw)) return [];
  const out: RailwayEnvironmentRef[] = [];
  for (const item of raw) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { name?: unknown }).name === 'string'
    ) {
      out.push({ id: (item as { id: string }).id, name: (item as { name: string }).name });
    }
  }
  return out;
}

function resolveProject(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ResolvedProject | { denied: string } {
  const own = resources.filter((r) => r.provider === PROVIDER);

  if (args.projectId !== undefined) {
    if (typeof args.projectId !== 'string' || !SAFE_IDENT.test(args.projectId)) {
      return { denied: 'projectId: malformed ref.' };
    }
    const match = own.find((r) => r.ref === args.projectId);
    if (!match) {
      return { denied: `railway project '${args.projectId}' is not a resource of this mission.` };
    }
    return resolved(match);
  }

  if (own.length === 1) return resolved(own[0]!);
  if (own.length === 0)
    return { denied: 'railway target: the mission touches no Railway project.' };

  // `accept-deploy` carries no projectId : find the project owning the environment.
  if (typeof args.environmentId === 'string') {
    const byEnv = own.filter((r) => environmentsOf(r).some((e) => e.id === args.environmentId));
    if (byEnv.length === 1) return resolved(byEnv[0]!);
  }
  return { denied: 'ambiguous railway target: specify projectId.' };
}

function resolved(resource: Resource): ResolvedProject {
  return { ref: resource.ref, env: resource.env ?? null };
}

function serviceSegment(
  args: Readonly<Record<string, unknown>>,
): { segment: SliceSegment } | { denied: string } {
  if (args.serviceId === undefined) return { segment: wildOne() };
  const id = ident(args.serviceId);
  if (!id) return { denied: 'serviceId: malformed ref.' };
  return { segment: id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice builders
// ─────────────────────────────────────────────────────────────────────────────

function classifyAccountOnly(kind: Kind): Slice[] {
  switch (kind) {
    case 'read-account-bare':
      return [slice([name('account'), wildOne()], 'R')];
    case 'read-account-projects':
      return [slice([name('account'), wildOne(), name('project'), wildOne()], 'R')];
    case 'write-create-project':
      return [slice([name('account'), wildOne(), name('project')], 'W')];
    default:
      return [];
  }
}

function classifyProjectScoped(
  kind: Kind,
  args: Readonly<Record<string, unknown>>,
  projectRef: string,
  env: string | null,
  service: SliceSegment,
): ClassifyOutcome {
  const envSeg: SliceSegment = env === null ? wildOne() : { kind: 'ident', value: env };
  const project = [name('project'), { kind: 'ident', value: projectRef } as SliceSegment];

  switch (kind) {
    case 'read-runtime-services':
      return {
        slices: [
          slice([...project, name('environment'), wildOne(), name('service'), wildOne()], 'R'),
        ],
      };

    case 'read-runtime-deployments':
      return {
        slices: [
          slice(
            [
              ...project,
              name('environment'),
              wildOne(),
              name('service'),
              wildOne(),
              name('deployment'),
              wildOne(),
            ],
            'R',
          ),
        ],
      };

    case 'read-runtime-status':
      return {
        slices: [
          slice(
            [
              ...project,
              name('environment'),
              wildOne(),
              name('service'),
              service,
              name('deployment'),
              wildOne(),
              name('status'),
            ],
            'R',
          ),
        ],
      };

    case 'read-runtime-logs':
      return {
        slices: [
          slice(
            [
              ...project,
              name('environment'),
              wildOne(),
              name('service'),
              service,
              name('deployment'),
              wildOne(),
              name('logs'),
            ],
            'R',
          ),
        ],
      };

    case 'write-deploy':
      return {
        slices: [
          slice(
            [...project, name('environment'), envSeg, name('service'), service, name('deployment')],
            'W',
          ),
        ],
      };

    case 'read-variables':
      return {
        slices: [
          slice([...project, name('environment'), envSeg, name('service-var'), wildOne()], 'R'),
        ],
      };

    case 'write-variable': {
      const leaf = singleVariableSegment(args);
      if ('denied' in leaf) return leaf;
      return {
        slices: [
          slice(
            [
              ...project,
              name('environment'),
              envSeg,
              name('service'),
              service,
              name('service-var'),
              leaf.segment,
            ],
            'W',
          ),
        ],
      };
    }

    case 'write-variables-bulk': {
      const leaf = bulkVariableSegment(args);
      if ('denied' in leaf) return leaf;
      return {
        slices: [
          slice(
            [
              ...project,
              name('environment'),
              envSeg,
              name('service'),
              service,
              name('service-var'),
              leaf.segment,
            ],
            'W',
          ),
        ],
      };
    }

    case 'write-agent': {
      const scope = [...project, name('environment'), envSeg, name('service'), wildOne()];
      return {
        slices: [
          // 1. the meta-tool itself → `railway.agent-action`.
          slice([name('account'), wildOne(), name('agent-session')], 'W'),
          // 2. deployment catch-all → `railway.deploy`.
          slice([...scope, name('deployment')], 'W'),
          // 3. variable catch-all → `railway.upsert-variable` + `railway.bulk-variables-replace`.
          slice([...scope, name('service-var'), wildOne()], 'W'),
        ],
      };
    }

    default:
      return { denied: `unsupported railway tool kind '${kind}'.` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable leaves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `upsert-variable` / `delete-variable` : the named variable as a one-item
 * list (name-aware audit). A missing name falls back to the wildcard — the
 * upstream call will fail validation but the classification stays
 * pessimistic. A malformed name is denied.
 */
function singleVariableSegment(
  args: Readonly<Record<string, unknown>>,
): { segment: SliceSegment } | { denied: string } {
  if (args.name === undefined || args.name === '') return { segment: wildOne() };
  const id = ident(args.name);
  if (!id) return { denied: 'name: malformed variable name.' };
  return { segment: { kind: 'list', values: [id.value] } };
}

/**
 * `upsert-variables` : `replace: true` ⇒ wildcard (destructive) ; otherwise
 * the list of keys in `variables`. Empty or non-object payload ⇒ wildcard
 * (pessimistic). A malformed key is denied.
 */
function bulkVariableSegment(
  args: Readonly<Record<string, unknown>>,
): { segment: SliceSegment } | { denied: string } {
  if (args.replace === true) return { segment: wildOne() };
  const vars = args.variables;
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
    const keys = Object.keys(vars);
    if (keys.length > 0) {
      if (!keys.every((k) => SAFE_IDENT.test(k))) {
        return { denied: 'variables: malformed variable name.' };
      }
      return { segment: { kind: 'list', values: keys } };
    }
  }
  return { segment: wildOne() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Segment helpers
// ─────────────────────────────────────────────────────────────────────────────

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function wildOne(): SliceSegment {
  return { kind: 'wild-one' };
}

function ident(value: unknown): Extract<SliceSegment, { kind: 'ident' }> | null {
  return typeof value === 'string' && SAFE_IDENT.test(value) ? { kind: 'ident', value } : null;
}

function slice(path: SliceSegment[], action: Slice['action']): Slice {
  return { provider: PROVIDER, path, action };
}
