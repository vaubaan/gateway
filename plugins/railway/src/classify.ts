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
 *   - `environmentId` is forwarded upstream as given, so it must designate
 *     an environment of the project the call is classified on : it is
 *     checked against the environments discovery stored on that project
 *     (`metadata.environments`). An id found nowhere in that list — or a
 *     project with no discovered environment — is denied. `accept-deploy`
 *     has nothing but `environmentId` to designate its target, so the
 *     argument is mandatory there.
 *   - The `environment[...]` segment carries the **owner label** of the
 *     project (`prod`, `staging`…), so env-qualified risks resolve ; an
 *     unlabelled project yields a wildcard segment, on which the policy
 *     engine refuses every env-scoped risk.
 *   - Identifiers embedded in a slice (`serviceId`, variable names) are
 *     validated against a safe character class ; a malformed one is denied.
 *
 * Crucial cases :
 *   1. Variable writes emit `service-var[K1,K2,…].W`, which matches
 *      `railway.upsert-variable`. The destructive "replace every variable"
 *      case is NOT carried by the shape of that leaf : it has its own
 *      marker slice, `…service[S].service-var-replace.W`, the only thing
 *      `railway.bulk-variables-replace` matches. `railway__upsert-variables`
 *      emits the marker when `replace` is anything but absent or `false`,
 *      and when the payload is empty or malformed (pessimistic) ; the
 *      variable leaf is then a wildcard.
 *   2. `railway__railway-agent` is an opaque meta-tool. Four slices are
 *      emitted in parallel so the mission must accept the union of what the
 *      agent could touch : `account[*].agent-session.W`, the deployment
 *      catch-all, the variable catch-all and the replace marker of the
 *      project.
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

export const PROVIDER = 'railway';

/** Identifier chars a slice segment accepts ; anything else is refused rather than escaped. */
const SAFE_IDENT = /^[a-zA-Z0-9_./~-]+$/;

/**
 * Leaf of the marker slice a "replace every variable" write emits next to
 * its `service-var[...]` slice. A virtual entity of the data model : the
 * catalog pattern of `railway.bulk-variables-replace` names it.
 */
export const REPLACE_ALL_VARIABLES_ENTITY = 'service-var-replace';

// ─────────────────────────────────────────────────────────────────────────────
// Tool table
// ─────────────────────────────────────────────────────────────────────────────

type AccountKind =
  | 'read-account-bare' // whoami
  | 'read-account-projects' // list-projects
  | 'write-create-project'; // create-project

type ProjectKind =
  | 'read-runtime-services' // list-services
  | 'read-runtime-deployments' // list-deployments
  | 'read-runtime-status' // get-status
  | 'read-runtime-logs' // get-logs
  | 'write-deploy' // redeploy, accept-deploy
  | 'write-agent' // railway-agent (meta-tool)
  | 'read-variables' // list-variables
  | 'write-variable' // upsert-variable, delete-variable
  | 'write-variables-bulk'; // upsert-variables (replace=true OR replace=false)

type Kind = AccountKind | ProjectKind;

const ACCEPT_DEPLOY = 'railway__accept-deploy';

const TOOL_KIND: Readonly<Record<string, Kind>> = {
  railway__whoami: 'read-account-bare',
  'railway__list-projects': 'read-account-projects',
  'railway__create-project': 'write-create-project',
  'railway__list-services': 'read-runtime-services',
  'railway__list-deployments': 'read-runtime-deployments',
  'railway__get-status': 'read-runtime-status',
  'railway__get-logs': 'read-runtime-logs',
  railway__redeploy: 'write-deploy',
  [ACCEPT_DEPLOY]: 'write-deploy',
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

function isAccountKind(kind: Kind): kind is AccountKind {
  return ACCOUNT_ONLY.has(kind);
}

/**
 * Tools whose upstream schema has no `projectId` : `environmentId` is the
 * only argument that designates their target, so it is mandatory.
 */
const TOOLS_ADDRESSED_BY_ENVIRONMENT: ReadonlySet<string> = new Set([ACCEPT_DEPLOY]);

/** True when the tool needs a Railway project resource to be classified. */
export function isProjectScopedTool(tool: string): boolean {
  const kind = TOOL_KIND[tool];
  return kind !== undefined && !isAccountKind(kind);
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

  if (isAccountKind(kind)) return classifyAccountOnly(kind);

  const project = locateProject(args, resources);
  if ('denied' in project) return project;

  const foreignEnvironment = environmentDenial(tool, args, project);
  if (foreignEnvironment) return foreignEnvironment;

  const service = serviceSegment(args);
  if ('denied' in service) return service;

  return classifyProjectScoped(kind, args, project.ref, project.env ?? null, service.segment);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource resolution
// ─────────────────────────────────────────────────────────────────────────────

interface Denial {
  readonly denied: string;
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

/** The mission's Railway project the call targets : explicit, single, or found by environment. */
function locateProject(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): Resource | Denial {
  const own = resources.filter((r) => r.provider === PROVIDER);

  if (args.projectId !== undefined) {
    if (typeof args.projectId !== 'string' || !SAFE_IDENT.test(args.projectId)) {
      return { denied: 'projectId: malformed ref.' };
    }
    const match = own.find((r) => r.ref === args.projectId);
    if (!match) {
      return { denied: `railway project '${args.projectId}' is not a resource of this mission.` };
    }
    return match;
  }

  if (own.length === 1) return own[0]!;
  if (own.length === 0)
    return { denied: 'railway target: the mission touches no Railway project.' };

  // `accept-deploy` carries no projectId : find the project owning the environment.
  if (typeof args.environmentId === 'string') {
    const byEnv = own.filter((r) => environmentsOf(r).some((e) => e.id === args.environmentId));
    if (byEnv.length === 1) return byEnv[0]!;
  }
  return { denied: 'ambiguous railway target: specify projectId.' };
}

/**
 * Bind `environmentId` to the located project, whichever way it was located.
 * The id is forwarded upstream unchanged and the OAuth token reaches every
 * project of the workspace, so an id the project does not own would run the
 * call outside the mission while the slice names the mission's project.
 * Returns the denial, or `null` when the call may be classified.
 */
function environmentDenial(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  project: Resource,
): Denial | null {
  const environmentId = args.environmentId;
  if (environmentId === undefined) {
    return TOOLS_ADDRESSED_BY_ENVIRONMENT.has(tool)
      ? { denied: 'environmentId: required, it is the only argument naming the target.' }
      : null;
  }
  if (typeof environmentId !== 'string' || !SAFE_IDENT.test(environmentId)) {
    return { denied: 'environmentId: malformed ref.' };
  }
  const known = environmentsOf(project);
  if (known.length === 0) {
    return {
      denied:
        `environmentId: the environments of railway project '${project.ref}' are unknown ; ` +
        `ask the connection owner to refresh the resources of the connection.`,
    };
  }
  if (!known.some((e) => e.id === environmentId)) {
    return { denied: `environmentId: not an environment of railway project '${project.ref}'.` };
  }
  return null;
}

function serviceSegment(
  args: Readonly<Record<string, unknown>>,
): { segment: SliceSegment } | Denial {
  if (args.serviceId === undefined) return { segment: wildOne() };
  const id = ident(args.serviceId);
  if (!id) return { denied: 'serviceId: malformed ref.' };
  return { segment: id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice builders
// ─────────────────────────────────────────────────────────────────────────────

function classifyAccountOnly(kind: AccountKind): ClassifyOutcome {
  switch (kind) {
    case 'read-account-bare':
      return { slices: [slice([name('account'), wildOne()], 'R')] };
    case 'read-account-projects':
      return { slices: [slice([name('account'), wildOne(), name('project'), wildOne()], 'R')] };
    case 'write-create-project':
      return { slices: [slice([name('account'), wildOne(), name('project')], 'W')] };
    default:
      return unsupportedKind(kind);
  }
}

/** Exhaustiveness guard : a kind added to the table without a case does not compile, and is refused. */
function unsupportedKind(kind: never): Denial {
  return { denied: `unsupported railway tool kind '${String(kind)}'.` };
}

function classifyProjectScoped(
  kind: ProjectKind,
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
      const scope = [...project, name('environment'), envSeg, name('service'), service];
      return { slices: [variableWriteSlice(scope, leaf.segment)] };
    }

    case 'write-variables-bulk': {
      const write = bulkVariableWrite(args);
      if ('denied' in write) return write;
      const scope = [...project, name('environment'), envSeg, name('service'), service];
      return {
        slices: write.replacesAll
          ? [variableWriteSlice(scope, write.segment), replaceAllVariablesSlice(scope)]
          : [variableWriteSlice(scope, write.segment)],
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
          // 3. variable catch-all → `railway.upsert-variable`.
          variableWriteSlice(scope, wildOne()),
          // 4. the agent may replace every variable → `railway.bulk-variables-replace`.
          replaceAllVariablesSlice(scope),
        ],
      };
    }

    default:
      return unsupportedKind(kind);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable writes
// ─────────────────────────────────────────────────────────────────────────────

/** `…service[S].service-var[<leaf>].W` — matched by `railway.upsert-variable`. */
function variableWriteSlice(scope: readonly SliceSegment[], leaf: SliceSegment): Slice {
  return slice([...scope, name('service-var'), leaf], 'W');
}

/** `…service[S].service-var-replace.W` — the only slice `railway.bulk-variables-replace` matches. */
function replaceAllVariablesSlice(scope: readonly SliceSegment[]): Slice {
  return slice([...scope, name(REPLACE_ALL_VARIABLES_ENTITY)], 'W');
}

/**
 * `upsert-variable` / `delete-variable` : the named variable as a one-item
 * list (name-aware audit). A missing or malformed name is denied : without
 * it the classifier cannot tell which variable the call writes.
 */
function singleVariableSegment(
  args: Readonly<Record<string, unknown>>,
): { segment: SliceSegment } | Denial {
  if (args.name === undefined || args.name === '') return { denied: 'name: required.' };
  const id = ident(args.name);
  if (!id) return { denied: 'name: malformed variable name.' };
  return { segment: { kind: 'list', values: [id.value] } };
}

/**
 * `upsert-variables` : the list of keys in `variables` when the call only
 * upserts them. It replaces every variable — wildcard leaf plus the marker
 * slice — when `replace` is set to anything but `false` (a non-boolean is
 * not trusted to mean "no"), and when the payload is empty or not an object
 * (pessimistic). A malformed key is denied.
 */
function bulkVariableWrite(
  args: Readonly<Record<string, unknown>>,
): { segment: SliceSegment; replacesAll: boolean } | Denial {
  if (args.replace !== undefined && args.replace !== false) {
    return { segment: wildOne(), replacesAll: true };
  }
  const vars = args.variables;
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
    const keys = Object.keys(vars);
    if (keys.length > 0) {
      if (!keys.every((k) => SAFE_IDENT.test(k))) {
        return { denied: 'variables: malformed variable name.' };
      }
      return { segment: { kind: 'list', values: keys }, replacesAll: false };
    }
  }
  return { segment: wildOne(), replacesAll: true };
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
