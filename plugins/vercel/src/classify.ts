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
 *   - secondary identifiers (deployment, domain, rule) are embedded when
 *     slice-safe and replaced by `[*]` otherwise — the catalog patterns match
 *     any ident there, so audit precision is all that is lost. The deployment
 *     segment is not proof of ownership : `execute` verifies, before the
 *     upstream call, that the deployment belongs to the resolved project ;
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

export const PROVIDER = 'vercel';

/** Vaubaan env labels of a Vercel project. The closed Vercel triad. */
export const VERCEL_ENVS = ['prod', 'preview', 'development'] as const;
export type VercelEnv = (typeof VERCEL_ENVS)[number];

/** Identifier chars a slice segment accepts (slice DSL `ident`). */
const SAFE_IDENT = /^[a-zA-Z0-9_/-]+$/;

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
 * one of the mission's Vercel resources ; absent, the mission's single Vercel
 * project applies ; anything else is a refusal.
 */
export function resolveProject(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
  required: boolean,
): { ref: string | null } | { denied: string } {
  const own = resources.filter((r) => r.provider === PROVIDER);
  const raw = args.projectId;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || raw.length === 0 || !SAFE_IDENT.test(raw)) {
      return { denied: 'projectId: malformed project ref' };
    }
    if (!own.some((r) => r.ref === raw)) {
      return { denied: `vercel project '${raw}' is not a resource of this mission.` };
    }
    return { ref: raw };
  }
  if (!required) return { ref: null };
  if (own.length === 1) return { ref: own[0]!.ref };
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
        slices: [
          slice('R', [name('project'), projectSeg, name('deployment'), deploymentIdentOf(args)]),
        ],
      };

    case 'vercel__get_deployment_build_logs':
      return {
        slices: [
          slice('R', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentIdentOf(args),
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
            deploymentIdentOf(args),
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
            deploymentIdentOf(args),
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
            deploymentIdentOf(args),
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
            deploymentIdentOf(args),
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
      const envVarId = safeIdent(args.id);
      const slices: Slice[] = VERCEL_ENVS.map((e) =>
        slice('W', [name('project'), projectSeg, name('env'), ident(e), name('env-var'), envVarId]),
      );
      slices.push(slice('W', [name('project'), projectSeg, name('env-var-fan-out')]));
      return { slices };
    }

    // ─── Writes — project settings ───────────────────────────────────

    case 'vercel__update_project_settings':
      return { slices: [slice('W', [name('project'), projectSeg, name('project-settings')])] };

    // ─── Writes — domains ────────────────────────────────────────────

    // Domains contain `.`, which the slice DSL refuses : FQDNs fall back to `[*]`.
    case 'vercel__add_project_domain':
      return {
        slices: [slice('W', [name('project'), projectSeg, name('domain'), safeIdent(args.name)])],
      };

    case 'vercel__verify_project_domain':
    case 'vercel__remove_project_domain':
      return {
        slices: [slice('W', [name('project'), projectSeg, name('domain'), safeIdent(args.domain)])],
      };

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

    case 'vercel__manage_ip_blocking':
      return {
        slices: [
          slice('W', [
            name('project'),
            projectSeg,
            name('firewall'),
            name('ip-rule'),
            safeIdent(args.id),
          ]),
        ],
      };

    default:
      return { denied: `unknown vercel tool '${tool}'.` };
  }
}

/** An ident segment when the value is slice-safe, `[*]` otherwise. */
function safeIdent(value: unknown): SliceSegment {
  if (typeof value === 'string' && value.length > 0 && SAFE_IDENT.test(value)) return ident(value);
  return ANY_IDENT;
}

/** Deployment id : the upstream surface uses `idOrUrl`, `deploymentId` or
 *  `url` depending on the tool — never `id`, which is the env-var id. Full
 *  URLs are not slice-safe and fall back to `[*]`. Audit precision only :
 *  ownership of the deployment is verified by `execute`. */
function deploymentIdentOf(args: Readonly<Record<string, unknown>>): SliceSegment {
  return safeIdent(args.idOrUrl ?? args.deploymentId ?? args.url);
}
