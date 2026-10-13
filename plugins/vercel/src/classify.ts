/**
 * Classifier of the `vercel` provider : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md §10
 *            ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/vercel.md §2 (mapping), §5 (edge cases).
 *
 * Pure : no IO, no credential, no `Date`. Every known tool maps to at least
 * one slice ; an unknown tool, a project the mission does not hold, an
 * ambiguous project, an argument the classifier cannot read, or a tool whose
 * target cannot be tied to a project is `denied` — never mapped to a broad or
 * a narrower slice.
 *
 * Conventions :
 *   - the project ref comes from `projectId` and must be a resource of the
 *     mission ; absent, it falls back to the mission's single Vercel project,
 *     and is refused when the mission holds several. `execute` resolves the
 *     project with the same function (`resolveProject`) ;
 *   - account-level tools (docs search, teams, projects list, registrar
 *     lookup) need no project ;
 *   - the environment is the closed Vercel triad, emitted as the
 *     `env[<label>]` segment. It is read from `target` only where the
 *     provider receives that argument (`upsert_env_var`) ; `deploy_to_vercel`
 *     has no such argument upstream and is always classified on `prod` ;
 *   - an identifier that reaches a request path (project, env var id,
 *     domain, deployment) is read by one grammar per kind — `pathIdent`,
 *     `domainName`, `readDeploymentTargets` — which `execute` calls too : a
 *     value outside the grammar is denied here and refused there, never
 *     escaped, so what is classified is what is sent ;
 *   - secondary identifiers are embedded in the slice when they are a
 *     `pathIdent` and replaced by `[*]` otherwise (a domain with a dot, a
 *     deployment hostname, a rule id that only travels in a JSON body) — the
 *     catalog patterns match any ident there, so audit precision is all that
 *     is lost. The deployment segment is not proof of ownership : `execute`
 *     verifies, before the upstream call, that the deployment belongs to the
 *     resolved project ;
 *   - the thread-addressed toolbar tools (`UNBOUND_TOOLS`) are denied : a
 *     thread id cannot be tied to a project, so the call could act on any
 *     project of the team.
 *
 * Four classification rules to keep : `upsert_env_var` honours the whole
 * `target` array and emits a fan-out marker ; `delete_env_var` touches every
 * env (the API ignores the hint) ; `get_access_to_vercel_url` is a credential
 * mint (`W`) ; `list_env_vars decrypt=true` adds the plaintext slice.
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

import { isCustomTool, toolDeclaresProperty, toolRequiresProperty } from './tools.ts';

export const PROVIDER = 'vercel';

/** Vaubaan env labels of a Vercel project. The closed Vercel triad. */
export const VERCEL_ENVS = ['prod', 'preview', 'development'] as const;
export type VercelEnv = (typeof VERCEL_ENVS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Identifier grammars — one per kind, shared with `execute`
// ─────────────────────────────────────────────────────────────────────────────

interface Denial {
  readonly denied: string;
}

/**
 * An opaque identifier of the provider (`prj_…`, an env var id, `dpl_…`) :
 * one path segment, no dot, no separator, no escape, bounded. It lands in a
 * slice **and** in a request path, so one grammar serves both. A wider class
 * is not safe for a URL : `encodeURIComponent` leaves `.` and `..` untouched
 * and every URL parser then removes them, so `…/env/..` would be sent as the
 * parent endpoint while the slice named an env var.
 */
export const PATH_IDENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The value as a path-safe identifier, or `null`. */
export function pathIdent(value: unknown): string | null {
  return typeof value === 'string' && PATH_IDENT.test(value) ? value : null;
}

/** Longest domain name the DNS carries. */
const DOMAIN_MAX_LENGTH = 253;

/**
 * A domain name : dot-separated labels of letters, digits and inner hyphens
 * (an IDN is given in its `xn--` form), with an optional leading wildcard
 * label. Dotted by nature, so the grammar is per label : no empty label, no
 * dot-only value, no separator, no whitespace — one path segment that a URL
 * parser leaves alone.
 */
const DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const DOMAIN_NAME = new RegExp(`^(?:\\*\\.)?${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*$`);

/** The value as a domain name, or `null`. */
export function domainName(value: unknown): string | null {
  return typeof value === 'string' && value.length <= DOMAIN_MAX_LENGTH && DOMAIN_NAME.test(value)
    ? value
    : null;
}

/** Refusals of a missing or malformed identifier, shared with `execute`. */
export const MALFORMED_ENV_VAR_ID = 'id: missing or malformed env var id';
export const MALFORMED_DOMAIN = 'domain: missing or malformed domain name';
export const MALFORMED_DOMAIN_NAME = 'name: missing or malformed domain name';

/** Arguments of a rewrapped tool that name a deployment (by id, hostname or URL). */
export const DEPLOYMENT_ARGS = ['idOrUrl', 'deploymentId', 'url'] as const;
export type DeploymentArg = (typeof DEPLOYMENT_ARGS)[number];

/**
 * A deployment id or a hostname : what the REST lookup accepts in its path.
 * The first character is a letter or a digit, so the value is never a
 * dot-only segment ; no separator, no escape, bounded like a domain name.
 */
const DEPLOYMENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/** One deployment argument, read. */
export interface DeploymentTarget {
  readonly arg: DeploymentArg;
  /** Deployment id or hostname, looked up under the pinned team. */
  readonly key: string;
  /** The normalised URL to forward, for a URL-addressed tool ; `null` to forward the verified id. */
  readonly href: string | null;
}

/**
 * Read one deployment argument. A URL is reduced to its hostname for the
 * lookup and re-serialised for the forward, so the host that is verified is
 * the host the upstream tool receives. Anything else than a deployment id, a
 * hostname or a plain http(s) URL is a denial.
 */
function readDeploymentArg(arg: DeploymentArg, value: unknown): DeploymentTarget | Denial {
  if (typeof value !== 'string' || value.length === 0) {
    return { denied: `${arg}: expected a deployment id or URL.` };
  }
  if (arg !== 'url' && !value.includes('://')) {
    if (!DEPLOYMENT_KEY.test(value)) return { denied: `${arg}: malformed deployment id.` };
    return { arg, key: value, href: null };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { denied: `${arg}: expected an absolute http(s) URL of a deployment.` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { denied: `${arg}: expected an http(s) URL.` };
  }
  if (url.username !== '' || url.password !== '') {
    return { denied: `${arg}: a URL with credentials is refused.` };
  }
  if (!DEPLOYMENT_KEY.test(url.hostname)) return { denied: `${arg}: malformed deployment host.` };
  return { arg, key: url.hostname, href: arg === 'url' ? url.href : null };
}

/**
 * The deployments a call of a rewrapped tool names, for `classify` and
 * `execute` alike. Schema-driven : every deployment argument the tool
 * declares is read (a required one must be there) ; one it does not declare
 * is a denial, since it would be forwarded without the ownership check.
 * A custom REST tool names no deployment and sends none of these arguments.
 */
export function readDeploymentTargets(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): { readonly targets: readonly DeploymentTarget[] } | Denial {
  if (isCustomTool(tool)) return { targets: [] };
  const targets: DeploymentTarget[] = [];
  for (const arg of DEPLOYMENT_ARGS) {
    if (!toolDeclaresProperty(tool, arg)) {
      if (args[arg] !== undefined) return { denied: `${arg}: not an argument of ${tool}.` };
      continue;
    }
    if (args[arg] === undefined) {
      if (toolRequiresProperty(tool, arg)) return { denied: `${arg}: argument missing.` };
      continue;
    }
    const target = readDeploymentArg(arg, args[arg]);
    if ('denied' in target) return target;
    targets.push(target);
  }
  return { targets };
}

/** Map a Vercel-side `target` literal to a Vaubaan env label. */
export function toVercelEnv(target: unknown): VercelEnv | null {
  if (target === 'production' || target === 'prod') return 'prod';
  if (target === 'preview') return 'preview';
  if (target === 'development') return 'development';
  return null;
}

/**
 * The environment a Vercel slice touches, read from its `env[<label>]`
 * segment. `null` for env-less slices (account, project settings, domains,
 * firewall, env-less deployment reads). Offered to the host as the resolver
 * for env-qualified Vercel risks : the project resource's owner label does
 * **not** carry the Vercel environment, the arguments do.
 */
export function vercelEnvOf(slice: Slice): VercelEnv | null {
  if (slice.provider !== PROVIDER) return null;
  for (let i = 0; i < slice.path.length - 1; i++) {
    const seg = slice.path[i]!;
    const next = slice.path[i + 1]!;
    if (seg.kind === 'name' && seg.value === 'env' && next.kind === 'ident') {
      return toVercelEnv(next.value);
    }
  }
  return null;
}

/** The `target` literals the Vercel API accepts, mapped to env labels. `execute`
 *  forwards the array untouched, so no other spelling is read here. */
const UPSERT_TARGETS: Readonly<Record<string, VercelEnv>> = {
  production: 'prod',
  preview: 'preview',
  development: 'development',
};

const UPSERT_TARGET_DENIAL =
  "target: expected an array of 'production', 'preview' or 'development' (omit it for all three)";

/** Normalise an `upsert_env_var` target array to the set of envs it affects.
 *  Absent or empty → all three (Vercel's default). `null` when the value is
 *  not an array or holds a literal the classifier cannot read : the call is
 *  then refused, never classified on the readable part alone. */
function envsForUpsert(target: unknown): VercelEnv[] | null {
  if (target === undefined) return [...VERCEL_ENVS];
  if (!Array.isArray(target)) return null;
  if (target.length === 0) return [...VERCEL_ENVS];
  const seen = new Set<VercelEnv>();
  for (const t of target) {
    const env =
      typeof t === 'string' && Object.hasOwn(UPSERT_TARGETS, t) ? UPSERT_TARGETS[t] : null;
    if (env === null || env === undefined) return null;
    seen.add(env);
  }
  return [...seen];
}

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: PROVIDER, path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

/** Concrete placeholder for an unknown identifier : the matcher treats
 *  `ident('*')` on the concrete side as "any specific identifier". */
const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

/** Tools that need no project : account-rooted reads. */
const ACCOUNT_TOOLS = new Set([
  'vercel__search_vercel_documentation',
  'vercel__list_teams',
  'vercel__list_projects',
  'vercel__check_domain_availability_and_price',
]);

/** Every tool the classifier knows, project-rooted ones included. */
const PROJECT_TOOLS = new Set([
  'vercel__get_project',
  'vercel__list_project_domains',
  'vercel__list_deployments',
  'vercel__get_deployment',
  'vercel__get_deployment_build_logs',
  'vercel__get_runtime_logs',
  'vercel__web_fetch_vercel_url',
  'vercel__list_toolbar_threads',
  'vercel__list_env_vars',
  'vercel__deploy_to_vercel',
  'vercel__get_access_to_vercel_url',
  'vercel__upsert_env_var',
  'vercel__delete_env_var',
  'vercel__update_project_settings',
  'vercel__add_project_domain',
  'vercel__verify_project_domain',
  'vercel__remove_project_domain',
  'vercel__get_firewall_config',
  'vercel__toggle_firewall',
  'vercel__upsert_firewall_rule',
  'vercel__remove_firewall_rule',
  'vercel__manage_ip_blocking',
]);

/**
 * Declared tools that are refused : they address a toolbar thread by id, the
 * upstream schema has no `projectId`, and no lookup ties a thread to a
 * project. Classified on the mission's project they would run on any thread
 * of the team. `list_toolbar_threads` takes `projectId` and stays available.
 */
export const UNBOUND_TOOLS: ReadonlySet<string> = new Set([
  'vercel__get_toolbar_thread',
  'vercel__change_toolbar_thread_resolve_status',
  'vercel__reply_to_toolbar_thread',
  'vercel__edit_toolbar_message',
  'vercel__add_toolbar_reaction',
]);

/** The refusal an agent reads for a tool of `UNBOUND_TOOLS`. */
export function unboundToolDenial(tool: string): string {
  return (
    `${tool}: a toolbar thread cannot be bound to a project of this mission ` +
    `(the tool takes a thread id and no project) — the tool is refused. ` +
    `Use vercel__list_toolbar_threads to read the threads of a mission project.`
  );
}

/** True for the account-rooted tools, which need no project. */
export function isAccountTool(tool: string): boolean {
  return ACCOUNT_TOOLS.has(tool);
}

/** True for a tool the classifier maps to slices (account- or project-rooted). */
export function isClassifiedTool(tool: string): boolean {
  return ACCOUNT_TOOLS.has(tool) || PROJECT_TOOLS.has(tool);
}

/**
 * Resolve the project a call touches. The explicit argument wins and must be
 * a `pathIdent` and one of the mission's Vercel resources ; absent, the
 * mission's single Vercel project applies ; anything else is a refusal.
 */
export function resolveProject(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
  required: boolean,
): { ref: string | null } | { denied: string } {
  const own = resources.filter((r) => r.provider === PROVIDER);
  if (args.projectId !== undefined) {
    const explicit = pathIdent(args.projectId);
    if (explicit === null) return { denied: 'projectId: malformed project ref' };
    if (!own.some((r) => r.ref === explicit)) {
      return { denied: `vercel project '${explicit}' is not a resource of this mission.` };
    }
    return { ref: explicit };
  }
  if (!required) return { ref: null };
  if (own.length === 1) {
    // The ref of the resource reaches the request path like an argument does.
    const only = pathIdent(own[0]!.ref);
    return only === null
      ? { denied: 'projectId: the project ref of this mission is not a path-safe identifier' }
      : { ref: only };
  }
  return {
    denied:
      own.length === 0
        ? 'projectId: argument missing and the mission touches no Vercel project'
        : `projectId: argument missing and the mission touches ${own.length} Vercel projects — name one`,
  };
}

/**
 * Classify a Vercel tool call into the slice(s) it touches.
 */
export function classifyVercel(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  if (UNBOUND_TOOLS.has(tool)) return { denied: unboundToolDenial(tool) };
  const accountTool = ACCOUNT_TOOLS.has(tool);
  if (!accountTool && !PROJECT_TOOLS.has(tool)) {
    return { denied: `unknown vercel tool '${tool}'.` };
  }

  // Account tools accept a projectId too (it is then checked, not used).
  const project = resolveProject(args, resources, !accountTool);
  if ('denied' in project) return project;
  const projectSeg: SliceSegment = project.ref !== null ? ident(project.ref) : ANY_IDENT;

  const deployments = readDeploymentTargets(tool, args);
  if ('denied' in deployments) return deployments;
  const deploymentSeg = deploymentSegment(deployments.targets);

  switch (tool) {
    // ─── Reads — account-level ────────────────────────────────────────

    case 'vercel__search_vercel_documentation':
      return { slices: [slice('R', [name('account'), name('docs')])] };

    case 'vercel__list_teams':
      return { slices: [slice('R', [name('account'), name('team'), ANY_IDENT])] };

    case 'vercel__list_projects':
      return { slices: [slice('R', [name('account'), name('project'), ANY_IDENT])] };

    case 'vercel__check_domain_availability_and_price':
      return { slices: [slice('R', [name('account'), name('domain-registrar')])] };

    // ─── Reads — project-rooted metadata ──────────────────────────────

    case 'vercel__get_project':
      return { slices: [slice('R', [name('project'), projectSeg, name('project-settings')])] };

    case 'vercel__list_project_domains':
      return { slices: [slice('R', [name('project'), projectSeg, name('domain'), ANY_IDENT])] };

    // ─── Reads — deployment-rooted ────────────────────────────────────

    case 'vercel__list_deployments':
      return {
        slices: [slice('R', [name('project'), projectSeg, name('deployment'), ANY_IDENT])],
      };

    case 'vercel__get_deployment':
      return {
        slices: [slice('R', [name('project'), projectSeg, name('deployment'), deploymentSeg])],
      };

    case 'vercel__get_deployment_build_logs':
      return {
        slices: [
          slice('R', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentSeg,
            name('build-log'),
          ]),
        ],
      };

    case 'vercel__get_runtime_logs':
      return {
        slices: [
          slice('R', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentSeg,
            name('runtime-log'),
          ]),
        ],
      };

    case 'vercel__web_fetch_vercel_url':
      return {
        slices: [
          slice('R', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentSeg,
            name('fetch'),
          ]),
        ],
      };

    case 'vercel__list_toolbar_threads':
      return {
        slices: [
          slice('R', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentSeg,
            name('toolbar-thread'),
            ANY_IDENT,
          ]),
        ],
      };

    // ─── Reads — env-var (plaintext discriminated) ────────────────────

    case 'vercel__list_env_vars': {
      const baseRead = slice('R', [name('project'), projectSeg, name('env-var'), ANY_IDENT]);
      if (args.decrypt === true) {
        return {
          slices: [
            baseRead,
            slice('R', [
              name('project'),
              projectSeg,
              name('env-var'),
              ANY_IDENT,
              name('plaintext'),
            ]),
          ],
        };
      }
      return { slices: [baseRead] };
    }

    // ─── Writes — deployment ─────────────────────────────────────────

    // The upstream tool declares no argument : a `target` would be read here
    // and ignored there, letting the caller pick the cheaper risk. Always prod.
    case 'vercel__deploy_to_vercel':
      return {
        slices: [
          slice('W', [name('project'), projectSeg, name('env'), ident('prod'), name('deployment')]),
        ],
      };

    // A credential mint, not a deployment read, even though the API is a GET.
    case 'vercel__get_access_to_vercel_url':
      return {
        slices: [
          slice('W', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentSeg,
            name('bypass-token'),
          ]),
        ],
      };

    // ─── Writes — env-var (fan-out + delete-all-envs) ─────────────────

    case 'vercel__upsert_env_var': {
      const envs = envsForUpsert(args.target);
      if (envs === null) return { denied: UPSERT_TARGET_DENIAL };
      const key = safeIdent(args.key);
      const slices: Slice[] = envs.map((e) =>
        slice('W', [name('project'), projectSeg, name('env'), ident(e), name('env-var'), key]),
      );
      if (envs.length > 1) {
        slices.push(slice('W', [name('project'), projectSeg, name('env-var-fan-out')]));
      }
      return { slices };
    }

    case 'vercel__delete_env_var': {
      // The upstream API removes the var from EVERY env it lives in — the
      // `target` arg is only a hint. Emit slices on all 3 envs so the right
      // risks are touched regardless of the hint, plus the fan-out marker.
      const envVarId = pathIdent(args.id);
      if (envVarId === null) return { denied: MALFORMED_ENV_VAR_ID };
      const slices: Slice[] = VERCEL_ENVS.map((e) =>
        slice('W', [
          name('project'),
          projectSeg,
          name('env'),
          ident(e),
          name('env-var'),
          ident(envVarId),
        ]),
      );
      slices.push(slice('W', [name('project'), projectSeg, name('env-var-fan-out')]));
      return { slices };
    }

    // ─── Writes — project settings ───────────────────────────────────

    case 'vercel__update_project_settings':
      return { slices: [slice('W', [name('project'), projectSeg, name('project-settings')])] };

    // ─── Writes — domains ────────────────────────────────────────────

    // Domains contain `.`, which the slice DSL refuses : FQDNs fall back to `[*]`.
    case 'vercel__add_project_domain': {
      const domain = domainName(args.name);
      if (domain === null) return { denied: MALFORMED_DOMAIN_NAME };
      return {
        slices: [slice('W', [name('project'), projectSeg, name('domain'), safeIdent(domain)])],
      };
    }

    // The domain is a path segment of the request : `execute` reads it with `domainName` too.
    case 'vercel__verify_project_domain':
    case 'vercel__remove_project_domain': {
      const domain = domainName(args.domain);
      if (domain === null) return { denied: MALFORMED_DOMAIN };
      return {
        slices: [slice('W', [name('project'), projectSeg, name('domain'), safeIdent(domain)])],
      };
    }

    // ─── Reads — firewall ────────────────────────────────────────────

    case 'vercel__get_firewall_config':
      return { slices: [slice('R', [name('project'), projectSeg, name('firewall')])] };

    // ─── Writes — firewall ───────────────────────────────────────────

    case 'vercel__toggle_firewall':
      return { slices: [slice('W', [name('project'), projectSeg, name('firewall')])] };

    case 'vercel__upsert_firewall_rule':
    case 'vercel__remove_firewall_rule':
      return {
        slices: [
          slice('W', [
            name('project'),
            projectSeg,
            name('firewall'),
            name('firewall-rule'),
            safeIdent(args.ruleId),
          ]),
        ],
      };

    // `id` names the rule of a `remove` only : `execute` does not send it on an `insert`.
    case 'vercel__manage_ip_blocking':
      return {
        slices: [
          slice('W', [
            name('project'),
            projectSeg,
            name('firewall'),
            name('ip-rule'),
            args.operation === 'remove' ? safeIdent(args.id) : ANY_IDENT,
          ]),
        ],
      };

    default:
      return { denied: `unknown vercel tool '${tool}'.` };
  }
}

/**
 * An ident segment when the value is a `pathIdent`, `[*]` otherwise. For
 * values that do not reach a request path (a JSON body field) or that were
 * already read by their own grammar (a domain) : only audit precision is at
 * stake.
 */
function safeIdent(value: unknown): SliceSegment {
  const id = pathIdent(value);
  return id === null ? ANY_IDENT : ident(id);
}

/**
 * The deployment segment of a slice : the id when the call names exactly one
 * deployment by a slice-safe id, `[*]` otherwise (a hostname, a URL, no
 * deployment argument). Audit precision only : ownership of the deployment
 * is verified by `execute`, on the targets `readDeploymentTargets` returned.
 */
function deploymentSegment(targets: readonly DeploymentTarget[]): SliceSegment {
  return targets.length === 1 ? safeIdent(targets[0]!.key) : ANY_IDENT;
}
