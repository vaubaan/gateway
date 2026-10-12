/**
 * Vercel v4 risk-based classifier — maps a concrete `(tool, args)` call to
 * the set of slices the runtime intersects with the risk catalog.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7.
 * Research : .vaubaan/research/providers/vercel.md §2 (mapping) and §5
 *            (edge cases) — the four latent v1 bugs are explicitly fixed
 *            here.
 *
 * Coexists with the v1 capability classifier (`classify.ts`) until the
 * Phase 3 cutover. The v1 classifier stays untouched ; this file is
 * additive.
 *
 * Bug fixes from v1 :
 *   1. `upsert_env_var` honors the full `target: string[]` array instead
 *      of degrading to a scalar (emits one slice per env, plus the
 *      fan-out marker slice when >1 env is touched).
 *   2. `delete_env_var` emits slices on all 3 envs (mirroring the real
 *      Vercel API which removes the var from every env it lives in,
 *      regardless of the `target` hint) and the fan-out marker.
 *   3. `get_access_to_vercel_url` is classified as a `bypass-token.W`
 *      (credential mint) instead of a plain `deployment.R`.
 *   4. `list_env_vars` with `decrypt=true` emits the plaintext-read slice
 *      in addition to the normal env-var read slice.
 */

import type { ProviderBinding, Slice, SliceSegment } from '@vaubaan/shared';

export type ClassifyResult = { slices: Slice[] } | { denied: string };

/** Vaubaan env slugs accepted on a Vercel binding. The closed Vercel triad. */
const VERCEL_ENVS = ['prod', 'preview', 'development'] as const;
type VercelEnv = (typeof VERCEL_ENVS)[number];

/** Map a Vercel-side `target` literal to a Vaubaan env slug. */
function toVaubanEnv(target: unknown): VercelEnv | null {
  if (target === 'production' || target === 'prod') return 'prod';
  if (target === 'preview') return 'preview';
  if (target === 'development') return 'development';
  return null;
}

/** Normalise an `upsert_env_var` target array to the set of Vaubaan envs it
 *  affects. Defaults to all 3 envs when absent or empty (Vercel's behaviour
 *  per `custom-tools.ts` description). */
function envsForUpsert(target: unknown): VercelEnv[] {
  if (!Array.isArray(target) || target.length === 0) return [...VERCEL_ENVS];
  const seen = new Set<VercelEnv>();
  for (const t of target) {
    const env = toVaubanEnv(t);
    if (env !== null) seen.add(env);
  }
  return seen.size === 0 ? [...VERCEL_ENVS] : [...seen];
}

/** Build a slice from its components. Internal helper — keeps the public
 *  call sites readable. */
function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: 'vercel', path: segments, action };
}

/** Convenience : a name segment (entity slug like `project`, `deployment`). */
function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

/** Convenience : a bracketed identifier (e.g. `[prj_abc]`, `[prod]`). */
function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

/** Convenience : a `[*]` placeholder ident used when the classifier has no
 *  concrete id for an entity (e.g. `list_*` tools that target the whole
 *  collection, or args with a non-ident value like a full URL). The matcher
 *  treats concrete `ident('*')` as any specific identifier — pattern
 *  `wild-one` (`[*]`) and pattern `wild-rec` (`[**]`) both match it. We do
 *  NOT use the structural `wild-one` segment kind on concrete slices, since
 *  `matches()` rejects wildcards on the concrete side. */
const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

/** Read a `projectId` arg uniformly (`projectId` or `project_id`). */
function projectIdOf(args: Record<string, unknown>): string | null {
  const v = args.projectId ?? args.project_id;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The set of Vercel project refs currently bound to the access token. */
function boundProjects(bindings: ReadonlyArray<ProviderBinding>): Set<string> {
  return new Set(bindings.filter((b) => b.provider === 'vercel').map((b) => b.resource_ref));
}

/**
 * Classify a Vercel tool call into the slice(s) it touches.
 *
 * Returns `{ slices: Slice[] }` on success — the runtime intersects each
 * slice with the catalog. Returns `{ denied: string }` for an unknown tool
 * or a `projectId` arg not covered by the bindings.
 */
export function classifyVercelV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  // Binding check : if the args carry a projectId, it must be one we hold.
  // Scope-injection upstream may fill it from the binding when absent ; we
  // do not enforce presence here.
  const pid = projectIdOf(args);
  if (pid !== null) {
    if (!boundProjects(bindings).has(pid)) {
      return { denied: `vercel project '${pid}' is not bound to this project.` };
    }
  }

  // Use a literal `P` ident as a placeholder when projectId is absent — the
  // matcher's project-rooted patterns use `[**]` and accept any single
  // segment, so the literal does not change the matching outcome but keeps
  // audit logs deterministic.
  const projectSeg: SliceSegment = pid !== null ? ident(pid) : ANY_IDENT;

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

    case 'vercel__get_toolbar_thread':
      return {
        slices: [
          slice('R', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentIdentOf(args),
            name('toolbar-thread'),
            toolbarThreadIdent(args),
          ]),
        ],
      };

    // ─── Reads — env-var (bug #4 : discriminate plaintext) ────────────

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

    case 'vercel__deploy_to_vercel': {
      const env = toVaubanEnv(args.target) ?? 'prod';
      return {
        slices: [
          slice('W', [name('project'), projectSeg, name('env'), ident(env), name('deployment')]),
        ],
      };
    }

    // bug #3 : get_access_to_vercel_url is a credential mint, not a deployment read.
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

    // ─── Writes — env-var (bug #1 + #2 : fan-out + delete-all-envs) ──

    case 'vercel__upsert_env_var': {
      const envs = envsForUpsert(args.target);
      const key = typeof args.key === 'string' ? args.key : '*';
      const slices: Slice[] = envs.map((e) =>
        slice('W', [
          name('project'),
          projectSeg,
          name('env'),
          ident(e),
          name('env-var'),
          ident(key),
        ]),
      );
      if (envs.length > 1) {
        slices.push(slice('W', [name('project'), projectSeg, name('env-var-fan-out')]));
      }
      return { slices };
    }

    case 'vercel__upsert_env_from_venv': {
      const envs = envsForUpsert(args.target);
      const key = typeof args.venv_key === 'string' ? args.venv_key : '*';
      const slices: Slice[] = envs.map((e) =>
        slice('W', [
          name('project'),
          projectSeg,
          name('env'),
          ident(e),
          name('env-var'),
          ident(key),
        ]),
      );
      if (envs.length > 1) {
        slices.push(slice('W', [name('project'), projectSeg, name('env-var-fan-out')]));
      }
      return { slices };
    }

    case 'vercel__delete_env_var': {
      // The upstream API removes the var from EVERY env it lives in — the
      // `target` arg is only a Vaubaan-side hint. We emit slices on all 3
      // envs to force the right gates regardless of the hint, plus the
      // fan-out marker so the operator confirms once.
      const envVarId = typeof args.id === 'string' ? args.id : '*';
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

    case 'vercel__add_project_domain':
    case 'vercel__verify_project_domain':
    case 'vercel__remove_project_domain':
      return {
        slices: [slice('W', [name('project'), projectSeg, name('domain'), domainIdent(args)])],
      };

    // ─── Reads — firewall ────────────────────────────────────────────

    case 'vercel__get_firewall_config':
      return {
        slices: [slice('R', [name('project'), projectSeg, name('firewall')])],
      };

    // ─── Writes — firewall ───────────────────────────────────────────

    case 'vercel__toggle_firewall':
      return {
        slices: [slice('W', [name('project'), projectSeg, name('firewall')])],
      };

    case 'vercel__upsert_firewall_rule':
      return {
        slices: [
          slice('W', [
            name('project'),
            projectSeg,
            name('firewall'),
            name('firewall-rule'),
            firewallRuleIdent(args),
          ]),
        ],
      };

    case 'vercel__remove_firewall_rule':
      return {
        slices: [
          slice('W', [
            name('project'),
            projectSeg,
            name('firewall'),
            name('firewall-rule'),
            firewallRuleIdent(args),
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
            ipRuleIdent(args),
          ]),
        ],
      };

    // ─── Writes — toolbar ────────────────────────────────────────────

    case 'vercel__change_toolbar_thread_resolve_status':
      return {
        slices: [
          slice('W', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentIdentOf(args),
            name('toolbar-thread'),
            toolbarThreadIdent(args),
          ]),
        ],
      };

    case 'vercel__reply_to_toolbar_thread':
      return {
        slices: [
          slice('W', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentIdentOf(args),
            name('toolbar-thread'),
            toolbarThreadIdent(args),
            name('toolbar-message'),
          ]),
        ],
      };

    case 'vercel__edit_toolbar_message':
    case 'vercel__add_toolbar_reaction':
      return {
        slices: [
          slice('W', [
            name('project'),
            projectSeg,
            name('deployment'),
            deploymentIdentOf(args),
            name('toolbar-thread'),
            toolbarThreadIdent(args),
            name('toolbar-message'),
            toolbarMessageIdent(args),
          ]),
        ],
      };

    default:
      return { denied: `unknown vercel tool '${tool}'.` };
  }
}

/** Best-effort deployment-id ident segment — wildcard if absent. The upstream
 *  Vercel surface uses three different arg names (`idOrUrl`, `deploymentId`,
 *  `url`) depending on the tool ; we accept any of them but NOT `id` which is
 *  the env-var id (would cross-talk with `delete_env_var`). Values that are
 *  not slice-safe idents (e.g. full URLs with `:` or `?`) are wildcarded for
 *  audit-log serialisation cleanliness. */
function deploymentIdentOf(args: Record<string, unknown>): SliceSegment {
  const v = args.idOrUrl ?? args.deploymentId ?? args.url;
  if (typeof v === 'string' && v.length > 0 && /^[a-zA-Z0-9_/-]+$/.test(v)) return ident(v);
  return ANY_IDENT;
}

/** Best-effort toolbar-thread-id ident segment — wildcard if absent. */
function toolbarThreadIdent(args: Record<string, unknown>): SliceSegment {
  const v = args.threadId ?? args.thread_id;
  if (typeof v === 'string' && v.length > 0) return ident(v);
  return ANY_IDENT;
}

/** Best-effort toolbar-message-id ident segment — wildcard if absent. */
function toolbarMessageIdent(args: Record<string, unknown>): SliceSegment {
  const v = args.messageId ?? args.message_id;
  if (typeof v === 'string' && v.length > 0) return ident(v);
  return ANY_IDENT;
}

/** Best-effort domain ident segment — wildcard if the value is not a clean
 *  slice ident (domains contain `.` which the DSL disallows). */
function domainIdent(args: Record<string, unknown>): SliceSegment {
  const v = args.domain ?? args.name;
  if (typeof v === 'string' && v.length > 0 && /^[a-zA-Z0-9_/-]+$/.test(v)) return ident(v);
  return ANY_IDENT;
}

/** Best-effort firewall-rule-id ident segment — wildcard if absent. */
function firewallRuleIdent(args: Record<string, unknown>): SliceSegment {
  const v = args.ruleId;
  if (typeof v === 'string' && v.length > 0) return ident(v);
  return ANY_IDENT;
}

/** Best-effort ip-rule ident segment — uses the rule `id` for remove, wildcard
 *  for insert (no stable id yet). */
function ipRuleIdent(args: Record<string, unknown>): SliceSegment {
  const v = args.id;
  if (typeof v === 'string' && v.length > 0) return ident(v);
  return ANY_IDENT;
}
