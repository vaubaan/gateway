/**
 * Everything the management door is built from (spec §4.1 bis).
 *
 * **The hard deny is this file.** The management surface never answers a
 * request, opens a gate, extends a budget, resets a period, touches a
 * connection, a share or a group, or executes a provider tool — "whatever
 * scope is requested". That is not enforced by checks inside the tools: the
 * module is *not handed* anything that could do it. `ManagementModuleDeps`
 * lists four ports — next to the build information and a logger — and
 * nothing else:
 *
 *   admit      the admission gate, as a function
 *   missions   seven methods of the mission service: read, preview, issue,
 *              rotate, revoke — not `setGate`, not `duplicate`, not
 *              `verifyToken`
 *   catalog    the shipped catalogs and presets, as plain data
 *   rateLimit  the surface rate limit, on keys of its own
 *
 * The composition root builds each port as an object of closures
 * (`compose/management.ts`), so no service instance, no repository and no
 * store handle is reachable from the door at run time either.
 * `hard-deny.test.ts` holds both halves: the types below, and the object
 * graph of the door built by the real root.
 *
 * Nothing under `server/management/` imports the modules of the forbidden
 * families (`requests`, `budget`, `execution`, `connections`, `shares`,
 * `groups`, `authority`, `store`); the same test reads the imports.
 */
import type { Preset } from '@vaubaan/shared';

import type { RateLimitDecision } from '../compose/ports';
import type { BuildInfo } from '../config';
import type { Logger } from '../logging';
import type { CatalogRisk, MissionService } from '../missions';
import type { AdmittedDelegation } from '../oauth-as';

/**
 * The part of the mission service the door may use, each method called with
 * the delegating user as the actor. `issue`, `rotate` and `revoke` receive the
 * delegation, so the mission records it and the audit names the client.
 */
export type ManagementMissions = Pick<
  MissionService,
  'issuanceContext' | 'preview' | 'issue' | 'rotate' | 'revoke' | 'list' | 'get'
>;

/** The names of `ManagementMissions`, for the composition root and the tests. */
export const MANAGEMENT_MISSION_METHODS = [
  'issuanceContext',
  'preview',
  'issue',
  'rotate',
  'revoke',
  'list',
  'get',
] as const satisfies readonly (keyof ManagementMissions)[];

/** One provider's catalog as the door shows it: explicit ids and presets, no behaviour. */
export interface ProviderCatalog {
  readonly provider: string;
  readonly provider_label: string;
  /** `ProviderPlugin.experimental`: left out of listings unless asked for. */
  readonly experimental: boolean;
  /** The plugin derives the environment from the call: env-qualified ids need no labelled resource. */
  readonly derives_env: boolean;
  /** The whole catalog as explicit `RiskId`s, catalog order. */
  readonly risks: readonly CatalogRisk[];
  readonly presets: readonly Preset[];
}

/** The catalogs of the plugins the instance ships: static data, read from the registry. */
export interface ManagementCatalog {
  /** Provider ids, registry order. */
  providers(): readonly string[];
  get(provider: string): ProviderCatalog | null;
}

/** The surface rate limit (`RateLimiter` port), on keys the root prefixes for this door. */
export interface ManagementRateLimit {
  take(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}

/** Admission of `/mcp/manage` (`ManagementGate.admit`): the delegation, or the refusal. */
export type ManagementAdmission = (request: Request) => Promise<AdmittedDelegation | Response>;

export interface ManagementModuleDeps {
  readonly admit: ManagementAdmission;
  readonly missions: ManagementMissions;
  readonly catalog: ManagementCatalog;
  readonly rateLimit: ManagementRateLimit;
  readonly build: BuildInfo;
  readonly logger: Logger;
}

/** The keys of `ManagementModuleDeps`: the whole of what the door is given. */
export const MANAGEMENT_DEPENDENCIES = [
  'admit',
  'missions',
  'catalog',
  'rateLimit',
  'build',
  'logger',
] as const satisfies readonly (keyof ManagementModuleDeps)[];

/**
 * Who a tool acts for: the user who gave the delegation — the actor and, for
 * an issuance, the creator — and the client that holds it.
 */
export interface ManagementActor {
  readonly userId: string;
  readonly delegationId: string;
  /** The OAuth client's public id (`delegated_client_id` in the audit). */
  readonly clientId: string;
}
