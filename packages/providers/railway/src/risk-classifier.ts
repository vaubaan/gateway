/**
 * Railway — v4 risk-based classifier.
 *
 * Source of truth : `.vaubaan/research/providers/railway-ssh.md` §1.3, §1.6.
 * Spec           : `docs/spec/gateway-risk-model.md` §3 (slice DSL), §7
 *                  (plugin contract), §8 (runtime strict-fail).
 *
 * Maps each Railway MCP tool to the *concrete* slice(s) it touches, in the
 * `railway.<containment-path>.<R|W>` DSL. The runtime intersects each slice
 * with the catalog (cf. `risk-catalog.ts`) and ALLOWs iff every touched
 * `RiskId` is in the token's `accepted_risks`.
 *
 * Crucial cases (cf. spec):
 *
 *   1. `railway__upsert-variables` is the only tool whose *args content*
 *      changes the slice shape :
 *        - `replace: true`  → emit a wildcard slice
 *          `railway.project[X].environment[Y].service[Z].service-var[*].W`
 *          which matches `railway.bulk-variables-replace` (deny by default).
 *        - `replace: false` (or absent) → emit a list slice
 *          `railway.project[X].environment[Y].service[Z].service-var[K1,K2,…].W`
 *          which still matches `upsert-variable-{staging,prod}` but NOT the
 *          destructive `bulk-variables-replace`. This resolves the v1 TODO
 *          (cf. research §1.6 edge 2 + research §3.1).
 *
 *   2. `railway__railway-agent` is a meta-tool with opaque action surface.
 *      We emit THREE slices in parallel (pessimistic) so the token must
 *      accept the union of risks the agent could *possibly* touch :
 *        - `railway.account[*].agent-session.W`     → `agent-action`
 *        - `railway.project[X].environment[Y].service[*].deployment.W`
 *                                                    → deploy-{staging,prod}
 *        - `railway.project[X].environment[Y].service[*].service-var[*].W`
 *                                                    → upsert-variable + bulk
 *      Without the catch-all slices an agent could request the meta-tool
 *      and have it redeploy prod without the token having `deploy-prod`.
 *      Reference : research §1.6 edge 1.
 *
 * Env qualification : project-scoped slices stamp the binding's
 * `environment` slug (Vaubaan side, e.g. `staging`/`prod` — not the Railway
 * native env name). Account-level tools (whoami, list-projects,
 * create-project, railway-agent) have account-only slices and one
 * project-scoped slice when applicable (railway-agent).
 */

import type { ProviderBinding, Slice } from '@vaubaan/shared';

export type RailwayClassifyResult = { slices: Slice[] } | { denied: string };

// ─────────────────────────────────────────────────────────────────────────────
// Slice constructors — tiny helpers to keep the mapping table compact.
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER = 'railway';

function name(value: string): Slice['path'][number] {
  return { kind: 'name', value };
}

function ident(value: string): Slice['path'][number] {
  return { kind: 'ident', value };
}

function wildOne(): Slice['path'][number] {
  return { kind: 'wild-one' };
}

function list(values: readonly string[]): Slice['path'][number] {
  return { kind: 'list', values };
}

function slice(path: Slice['path'], action: Slice['action']): Slice {
  return { provider: PROVIDER, path, action };
}

// ─────────────────────────────────────────────────────────────────────────────
// Binding resolution — same conventions as classify.ts (v1).
// ─────────────────────────────────────────────────────────────────────────────

function railwayBindings(bindings: ReadonlyArray<ProviderBinding>): ProviderBinding[] {
  return bindings.filter((b) => b.provider === 'railway');
}

function targetProjectId(args: Record<string, unknown>): string | undefined {
  if (typeof args.projectId === 'string') return args.projectId;
  if (typeof args.project_id === 'string') return args.project_id;
  return undefined;
}

function targetServiceId(args: Record<string, unknown>): string | undefined {
  if (typeof args.serviceId === 'string') return args.serviceId;
  if (typeof args.service_id === 'string') return args.service_id;
  return undefined;
}

/** Resolve the Railway project id + binding env. Mirrors classify.ts (v1)
 *  but returns a `denied` reason when ambiguous (multiple bindings, no arg). */
function resolveProjectBinding(
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): { projectId: string; env: string } | { denied: string } {
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
  // `environment` slug is the Vaubaan-side env. Wildcard when missing (binding
  // is multi-env / not env-pinned) so the catalog can still match.
  const env = binding.environment ?? '*';
  return { projectId, env };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool category — drives the slice shape.
// ─────────────────────────────────────────────────────────────────────────────

type Kind =
  | 'read-account-bare' // whoami
  | 'read-account-projects' // list-projects
  | 'read-runtime-services' // list-services
  | 'read-runtime-deployments' // list-deployments
  | 'read-runtime-status' // get-status
  | 'read-runtime-logs' // get-logs
  | 'write-redeploy' // redeploy
  | 'write-accept-deploy' // accept-deploy
  | 'write-agent' // railway-agent (meta-tool)
  | 'write-create-project' // create-project
  | 'read-variables' // list-variables
  | 'write-upsert-variable' // upsert-variable
  | 'write-upsert-variables' // upsert-variables (replace=true OR replace=false)
  | 'write-delete-variable'; // delete-variable

const TOOL_KIND: Record<string, Kind> = {
  railway__whoami: 'read-account-bare',
  'railway__list-projects': 'read-account-projects',
  'railway__list-services': 'read-runtime-services',
  'railway__list-deployments': 'read-runtime-deployments',
  'railway__get-status': 'read-runtime-status',
  'railway__get-logs': 'read-runtime-logs',
  railway__redeploy: 'write-redeploy',
  'railway__accept-deploy': 'write-accept-deploy',
  'railway__railway-agent': 'write-agent',
  'railway__create-project': 'write-create-project',
  'railway__list-variables': 'read-variables',
  'railway__upsert-variable': 'write-upsert-variable',
  'railway__upsert-variables': 'write-upsert-variables',
  'railway__delete-variable': 'write-delete-variable',
};

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
  // railway-agent ALSO needs a project binding for the catch-all slices.
  'railway__railway-agent',
]);

// ─────────────────────────────────────────────────────────────────────────────
// classifyRailwayV4 — the public entry-point.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a Railway tool call into v4 slice(s).
 *
 * @returns `{ slices: [...] }` on success, or `{ denied: '<reason>' }` when
 *          the tool is unknown or the binding cannot be resolved.
 */
export function classifyRailwayV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): RailwayClassifyResult {
  const kind = TOOL_KIND[tool];
  if (!kind) return { denied: `unknown railway tool '${tool}'.` };

  // Account-only branch — no binding lookup, no env in the slice.
  if (!ENV_FROM_BINDING.has(tool)) {
    return { slices: classifyAccountOnly(kind) };
  }

  // Project-scoped tools : resolve binding + env first.
  const resolved = resolveProjectBinding(args, bindings);
  if ('denied' in resolved) return resolved;

  return { slices: classifyProjectScoped(kind, args, resolved.projectId, resolved.env) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice builders per tool kind.
// ─────────────────────────────────────────────────────────────────────────────

function classifyAccountOnly(kind: Kind): Slice[] {
  switch (kind) {
    case 'read-account-bare':
      // whoami : account-level R.
      return [slice([name('account'), wildOne()], 'R')];

    case 'read-account-projects':
      // list-projects : account-level R, project entity in the path.
      return [slice([name('account'), wildOne(), name('project'), wildOne()], 'R')];

    case 'write-create-project':
      // create-project : account-level W, project entity as the W leaf.
      return [slice([name('account'), wildOne(), name('project')], 'W')];

    default:
      // Should never happen — ENV_FROM_BINDING filters the rest.
      return [];
  }
}

function classifyProjectScoped(
  kind: Kind,
  args: Record<string, unknown>,
  projectId: string,
  env: string,
): Slice[] {
  const serviceId = targetServiceId(args);
  const serviceSeg = serviceId !== undefined ? ident(serviceId) : wildOne();

  switch (kind) {
    case 'read-runtime-services':
      // list-services : all services under project/env.
      return [
        slice(
          [
            name('project'),
            ident(projectId),
            name('environment'),
            wildOne(),
            name('service'),
            wildOne(),
          ],
          'R',
        ),
      ];

    case 'read-runtime-deployments':
      // list-deployments : services × deployments under project/env.
      return [
        slice(
          [
            name('project'),
            ident(projectId),
            name('environment'),
            wildOne(),
            name('service'),
            wildOne(),
            name('deployment'),
            wildOne(),
          ],
          'R',
        ),
      ];

    case 'read-runtime-status':
      // get-status : service status under project/env.
      return [
        slice(
          [
            name('project'),
            ident(projectId),
            name('environment'),
            wildOne(),
            name('service'),
            serviceSeg,
            name('deployment'),
            wildOne(),
            name('status'),
          ],
          'R',
        ),
      ];

    case 'read-runtime-logs':
      // get-logs : deployment logs under project/env.
      return [
        slice(
          [
            name('project'),
            ident(projectId),
            name('environment'),
            wildOne(),
            name('service'),
            serviceSeg,
            name('deployment'),
            wildOne(),
            name('logs'),
          ],
          'R',
        ),
      ];

    case 'write-redeploy':
    case 'write-accept-deploy':
      // redeploy / accept-deploy : deployment.W qualified by env slug.
      return [
        slice(
          [
            name('project'),
            ident(projectId),
            name('environment'),
            ident(env),
            name('service'),
            serviceSeg,
            name('deployment'),
          ],
          'W',
        ),
      ];

    case 'read-variables':
      // list-variables : service-var.R (project & env qualified ; service wildcard).
      return [
        slice(
          [
            name('project'),
            ident(projectId),
            name('environment'),
            ident(env),
            name('service-var'),
            wildOne(),
          ],
          'R',
        ),
      ];

    case 'write-upsert-variable':
      // upsert-variable : one var name explicit → list of one (or ident if known).
      return [
        slice(
          [
            name('project'),
            ident(projectId),
            name('environment'),
            ident(env),
            name('service'),
            serviceSeg,
            name('service-var'),
            varSegmentSingle(args),
          ],
          'W',
        ),
      ];

    case 'write-upsert-variables':
      // CRUCIAL : args.replace gates the slice shape.
      return [
        slice(
          [
            name('project'),
            ident(projectId),
            name('environment'),
            ident(env),
            name('service'),
            serviceSeg,
            name('service-var'),
            varSegmentBulk(args),
          ],
          'W',
        ),
      ];

    case 'write-delete-variable':
      // delete-variable : one var name → list of one (when known).
      return [
        slice(
          [
            name('project'),
            ident(projectId),
            name('environment'),
            ident(env),
            name('service'),
            serviceSeg,
            name('service-var'),
            varSegmentSingle(args),
          ],
          'W',
        ),
      ];

    case 'write-agent': {
      // Meta-tool : THREE slices in parallel (cf. file header + research §1.6).
      const projectSegments = [
        name('project'),
        ident(projectId),
        name('environment'),
        ident(env),
        name('service'),
        wildOne(),
      ];
      return [
        // 1. agent-session match (touches `railway.agent-action`).
        slice([name('account'), wildOne(), name('agent-session')], 'W'),
        // 2. deployment catch-all (touches deploy-staging / deploy-prod).
        slice([...projectSegments, name('deployment')], 'W'),
        // 3. service-var catch-all (touches upsert-variable-* + bulk-variables-replace).
        slice([...projectSegments, name('service-var'), wildOne()], 'W'),
      ];
    }

    default:
      // Should never happen — switch is exhaustive on the project-scoped kinds.
      return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable-segment builders : the var-name aware slice leaf.
// ─────────────────────────────────────────────────────────────────────────────

/** For `upsert-variable` / `delete-variable` : the single var name as a
 *  one-item list (matches catalog patterns expecting `service-var[**]` or
 *  `service-var[*]`). When the arg is missing, fallback to wild-one — the
 *  upstream call will fail validation but the classification stays sound. */
function varSegmentSingle(args: Record<string, unknown>): Slice['path'][number] {
  if (typeof args.name === 'string' && args.name.length > 0) {
    // Use a list-of-one so the leaf is name-aware (audit logs show the key).
    return list([args.name]);
  }
  return wildOne();
}

/** For `upsert-variables` (bulk) : `replace=true` ⇒ wildcard (matches the
 *  destructive `bulk-variables-replace` risk) ; `replace=false` ⇒ list of
 *  keys from `args.variables`. When `variables` is malformed, fallback to
 *  wildcard (pessimistic). */
function varSegmentBulk(args: Record<string, unknown>): Slice['path'][number] {
  const replace = args.replace === true;
  if (replace) {
    // DESTRUCTIVE branch — wildcard matches bulk-variables-replace.
    return wildOne();
  }
  // Non-destructive : narrow to the keys present in the payload.
  const vars = args.variables;
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
    const keys = Object.keys(vars);
    if (keys.length > 0) {
      return list(keys);
    }
  }
  // Empty / malformed → fall back to wildcard (safer).
  return wildOne();
}
