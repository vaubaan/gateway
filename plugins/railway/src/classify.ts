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
 *   - Every identifier has one grammar, which `execute` uses too : a Railway
 *     id (`projectId`, `environmentId`, `serviceId`) is a `railwayId`, a
 *     variable name a `variableName` ; a malformed one is denied, never
 *     escaped. `execute` resolves the call with the same `resolveTarget` and
 *     `readVariableWrite`, and sends the ids they return : what is
 *     classified is what is sent.
 *   - **Every id that is forwarded is bound to the mission's project.** A
 *     `serviceId` is one of the services discovery stored on the project
 *     (`servicesOf`, `readService`, through `resolveTarget`), an
 *     `environmentId` one of its environments. Two arguments of the upstream
 *     tools name an object nothing here can bind — discovery stores no
 *     deployment and no agent thread, and the classifier is pure — so they
 *     are **refused**, never forwarded : `deploymentId` of `get-logs` and
 *     `threadId` of `railway-agent` (`UNBOUND_ARGUMENTS`). The same
 *     credential reaches every project of the workspace : a forwarded id
 *     would let a mission on one project read the logs, or continue the
 *     agent conversation, of another.
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

import {
  declaredArgumentsOf,
  undeclaredArgumentDenial,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';
import { railwayTools, UNBOUND_ARGUMENTS } from './tools.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Identifier grammars — one per kind, shared with `execute`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An id Railway issues (project, environment, service, deployment — UUIDs) :
 * letters, digits, `_` and `-`, bounded. No dot, no separator, no escape :
 * the value is safe in a slice segment and names one object wherever the
 * provider places it. Anything else is refused rather than escaped.
 */
export const RAILWAY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The value as a Railway id, or `null`. */
export function railwayId(value: unknown): string | null {
  return typeof value === 'string' && RAILWAY_ID.test(value) ? value : null;
}

/**
 * A variable name : the characters a slice list item accepts (no comma, no
 * bracket, no whitespace), bounded. It travels as a GraphQL variable only.
 */
export const VARIABLE_NAME = /^[a-zA-Z0-9_./~-]{1,256}$/;

/** The value as a variable name, or `null`. */
export function variableName(value: unknown): string | null {
  return typeof value === 'string' && VARIABLE_NAME.test(value) ? value : null;
}

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

const TOOL_KIND: Readonly<Record<string, Kind>> = {
  [TOOL.whoami]: 'read-account-bare',
  [TOOL.listProjects]: 'read-account-projects',
  [TOOL.createProject]: 'write-create-project',
  [TOOL.listServices]: 'read-runtime-services',
  [TOOL.listDeployments]: 'read-runtime-deployments',
  [TOOL.getStatus]: 'read-runtime-status',
  [TOOL.getLogs]: 'read-runtime-logs',
  [TOOL.redeploy]: 'write-deploy',
  [TOOL.acceptDeploy]: 'write-deploy',
  [TOOL.railwayAgent]: 'write-agent',
  [TOOL.listVariables]: 'read-variables',
  [TOOL.upsertVariable]: 'write-variable',
  [TOOL.deleteVariable]: 'write-variable',
  [TOOL.upsertVariables]: 'write-variables-bulk',
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
const TOOLS_ADDRESSED_BY_ENVIRONMENT: ReadonlySet<string> = new Set([TOOL.acceptDeploy]);

/** True when the tool needs a Railway project resource to be classified. */
export function isProjectScopedTool(tool: string): boolean {
  const kind = TOOL_KIND[tool];
  return kind !== undefined && !isAccountKind(kind);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

const DECLARED_ARGUMENTS = declaredArgumentsOf(railwayTools);
/** Checked by `resolveTarget` ; `execute` writes it again where the tool takes it and drops it elsewhere. */
const ROUTING_ARGUMENTS: ReadonlySet<string> = new Set(['projectId']);

/**
 * The refusal for an argument `tool` does not declare, `null` when there is none :
 * the one rule `classify` and `execute` both apply, so neither side sends what the
 * other never read.
 */
export function undeclaredArgument(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): string | null {
  return (
    unboundArgument(tool, args) ??
    undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args, ROUTING_ARGUMENTS)
  );
}

/**
 * The refusal for an argument that names an object the plugin cannot bind to
 * the mission's project (`UNBOUND_ARGUMENTS`), `null` when the call carries
 * none. Present is refused, whatever the value — `null` and `''` included :
 * the argument is not read, so no value of it is acceptable.
 */
export function unboundArgument(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): string | null {
  const unbound = Object.hasOwn(UNBOUND_ARGUMENTS, tool) ? UNBOUND_ARGUMENTS[tool] : undefined;
  if (unbound === undefined) return null;
  for (const [name, instead] of Object.entries(unbound)) {
    if (Object.hasOwn(args, name)) {
      return `${name}: not accepted by '${tool}' — it cannot be bound to the mission's project, so it is not sent. ${instead}`;
    }
  }
  return null;
}

export function classifyRailway(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const kind = Object.hasOwn(TOOL_KIND, tool) ? TOOL_KIND[tool] : undefined;
  if (!kind) return { denied: `unknown railway tool '${tool}'.` };
  // The rewrapped tools forward their arguments whole: one the schema does not
  // declare is refused here rather than left to the upstream schema to reject.
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared !== null) return { denied: undeclared };

  if (isAccountKind(kind)) return classifyAccountOnly(kind);

  const target = resolveTarget(tool, args, resources);
  if ('denied' in target) return target;

  const write = readVariableWrite(tool, args);
  if (write !== null && 'denied' in write) return write;

  const service: SliceSegment =
    target.serviceId === null ? wildOne() : { kind: 'ident', value: target.serviceId };
  return classifyProjectScoped(
    kind,
    target.project.ref,
    target.project.env ?? null,
    service,
    write,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource resolution
// ─────────────────────────────────────────────────────────────────────────────

export interface Denial {
  readonly denied: string;
}

/** Refusals of a call that names no project the mission could resolve ; `execute` reads them. */
export const NO_RAILWAY_PROJECT = 'railway target: the mission touches no Railway project.';
export const AMBIGUOUS_RAILWAY_TARGET = 'ambiguous railway target: specify projectId.';

/**
 * What a project-scoped call runs on, as `classify` and `execute` both read
 * it. Every id went through `railwayId` ; `project` is a resource of the
 * mission, and `environmentId` and `serviceId`, when given, are one of its
 * discovered environments and one of its discovered services. There is no
 * other id : a call that names a deployment or an agent thread is refused
 * before it gets here (`unboundArgument`).
 */
export interface RailwayTarget {
  readonly project: Resource;
  readonly environmentId: string | null;
  readonly serviceId: string | null;
}

/**
 * Resolve the target of a project-scoped call — the **only** place that
 * decides it. `execute` calls it with the same inputs and writes the request
 * from its answer, so a call reaches the project, environment and service its
 * slices name, or nothing at all.
 */
export function resolveTarget(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): RailwayTarget | Denial {
  const project = locateProject(args, resources);
  if ('denied' in project) return project;
  // The ref of the resource is sent like an argument is : same grammar.
  if (railwayId(project.ref) === null) {
    return { denied: 'projectId: the project ref of this mission is not a Railway identifier.' };
  }

  const environment = readEnvironment(tool, args, project);
  if ('denied' in environment) return environment;

  const service = readService(args, project);
  if ('denied' in service) return service;
  return { project, environmentId: environment.id, serviceId: service.id };
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

/** `{ id, name }` pairs the discovery stores under `metadata.services`. */
export interface RailwayServiceRef {
  readonly id: string;
  readonly name: string;
}

/**
 * The discovered services of a project resource ; `null` when the resource carries no
 * list at all (it was discovered before services were recorded), which is not the same
 * as a project with no service.
 */
export function servicesOf(resource: Resource): readonly RailwayServiceRef[] | null {
  const raw = resource.metadata?.services;
  if (!Array.isArray(raw)) return null;
  const out: RailwayServiceRef[] = [];
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

/**
 * Read `serviceId` and bind it to the located project, as `readEnvironment` binds the
 * environment. The id is sent upstream and the OAuth token reaches every project of
 * the workspace : a service the project does not own would scope the call — a
 * redeploy, a variable write, the upstream agent's context — outside the mission
 * while the slice names the mission's project. `id` is `null` when the call names
 * no service.
 */
function readService(
  args: Readonly<Record<string, unknown>>,
  project: Resource,
): { readonly id: string | null } | Denial {
  if (args.serviceId === undefined) return { id: null };
  const serviceId = railwayId(args.serviceId);
  if (serviceId === null) return { denied: 'serviceId: malformed ref.' };
  const known = servicesOf(project);
  if (known === null) {
    return {
      denied:
        `serviceId: the services of railway project '${project.ref}' are unknown ; ` +
        `ask the connection owner to refresh the resources of the connection.`,
    };
  }
  if (!known.some((service) => service.id === serviceId)) {
    return {
      denied:
        `serviceId: not a service of railway project '${project.ref}' as last discovered ; ` +
        `a service created since then appears once the connection owner refreshes the resources.`,
    };
  }
  return { id: serviceId };
}

/** The mission's Railway project the call targets : explicit, single, or found by environment. */
function locateProject(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): Resource | Denial {
  const own = resources.filter((r) => r.provider === PROVIDER_ID);

  if (args.projectId !== undefined) {
    const explicit = railwayId(args.projectId);
    if (explicit === null) return { denied: 'projectId: malformed ref.' };
    const match = own.find((r) => r.ref === explicit);
    if (!match) {
      return { denied: `railway project '${explicit}' is not a resource of this mission.` };
    }
    return match;
  }

  if (own.length === 1) return own[0]!;
  if (own.length === 0) return { denied: NO_RAILWAY_PROJECT };

  // `accept-deploy` carries no projectId : find the project owning the environment.
  if (typeof args.environmentId === 'string') {
    const byEnv = own.filter((r) => environmentsOf(r).some((e) => e.id === args.environmentId));
    if (byEnv.length === 1) return byEnv[0]!;
  }
  return { denied: AMBIGUOUS_RAILWAY_TARGET };
}

/**
 * Read `environmentId` and bind it to the located project, whichever way it
 * was located. The id is sent upstream and the OAuth token reaches every
 * project of the workspace, so an id the project does not own would run the
 * call outside the mission while the slice names the mission's project.
 * `id` is `null` when the call names no environment.
 */
function readEnvironment(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  project: Resource,
): { readonly id: string | null } | Denial {
  if (args.environmentId === undefined) {
    return TOOLS_ADDRESSED_BY_ENVIRONMENT.has(tool)
      ? { denied: 'environmentId: required, it is the only argument naming the target.' }
      : { id: null };
  }
  const environmentId = railwayId(args.environmentId);
  if (environmentId === null) return { denied: 'environmentId: malformed ref.' };
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
  return { id: environmentId };
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
  projectRef: string,
  env: string | null,
  service: SliceSegment,
  write: VariableWrite | null,
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

    case 'write-variable':
    case 'write-variables-bulk': {
      if (write === null) return { denied: 'variables: the write could not be read.' };
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

/** The variable leaf of a write, and whether the write replaces every variable. */
export interface VariableWrite {
  readonly segment: SliceSegment;
  readonly replacesAll: boolean;
}

/**
 * The variables a call writes, as `classify` and `execute` both read them ;
 * `null` for a tool that writes none. A denial here is a refusal there.
 */
export function readVariableWrite(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): VariableWrite | Denial | null {
  const kind = TOOL_KIND[tool];
  if (kind === 'write-variable') return singleVariableWrite(args);
  if (kind === 'write-variables-bulk') return bulkVariableWrite(args);
  return null;
}

/**
 * `upsert-variable` / `delete-variable` : the named variable as a one-item
 * list (name-aware audit). A missing or malformed name is denied : without
 * it the classifier cannot tell which variable the call writes.
 */
function singleVariableWrite(args: Readonly<Record<string, unknown>>): VariableWrite | Denial {
  if (args.name === undefined || args.name === '') return { denied: 'name: required.' };
  const id = variableName(args.name);
  if (id === null) return { denied: 'name: malformed variable name.' };
  return { segment: { kind: 'list', values: [id] }, replacesAll: false };
}

/**
 * `upsert-variables` : the list of keys in `variables` when the call only
 * upserts them. It replaces every variable — wildcard leaf plus the marker
 * slice — when `replace` is set to anything but `false` (a non-boolean is
 * not trusted to mean "no"), and when the payload is empty or not an object
 * (pessimistic). A malformed key is denied.
 */
function bulkVariableWrite(args: Readonly<Record<string, unknown>>): VariableWrite | Denial {
  if (args.replace !== undefined && args.replace !== false) {
    return { segment: wildOne(), replacesAll: true };
  }
  const vars = args.variables;
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
    const keys = Object.keys(vars);
    if (keys.length > 0) {
      if (!keys.every((k) => variableName(k) !== null)) {
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

function slice(path: SliceSegment[], action: Slice['action']): Slice {
  return { provider: PROVIDER_ID, path, action };
}
