/**
 * Everything the host side of the `vaubaan` plugin is built from (spec §4.1 bis;
 * ADR platform-management-is-a-plugin-on-the-execution-door).
 *
 * **The hard deny is this file.** The management tools never answer a request,
 * open a gate, extend a budget, reset a period, touch an account, a share or a
 * group, or call another service's tool — whatever the arguments say. That is
 * not enforced by checks inside the acts: the module is *not handed* anything
 * that could do it. `VaubaanModuleDeps` lists two ports — next to a logger —
 * and nothing else:
 *
 *   missions   seven methods of the mission service: read, preview, issue,
 *              rotate, revoke — not `setGate`, not `duplicate`, not
 *              `verifyToken`, not `edit`
 *   catalog    the shipped catalogs and macro-actions, as plain data
 *
 * The composition root builds each port as an object of closures
 * (`compose/vaubaan.ts`), so no service instance, no repository and no store
 * handle is reachable from the plugin's ports at run time either.
 * `hard-deny.test.ts` holds both halves: the types below, and the object graph
 * of the ports built by the real root.
 *
 * Nothing under `server/vaubaan/` imports the modules of the forbidden families
 * (`requests`, `budget`, `execution`, `accounts`, `shares`, `groups`,
 * `authority`, `store`); the same test reads the imports.
 */
import type { MacroAction } from '@vaubaan/shared';

import type { Logger } from '../logging';
import type { CatalogRisk, MissionService } from '../missions';

/**
 * The part of the mission service the acts may use, each method called with
 * the calling mission's creator as the actor. `issue`, `rotate` and `revoke`
 * receive the calling mission, so a mission records who issued it and the audit
 * names it.
 */
export type VaubaanMissions = Pick<
  MissionService,
  'issuanceContext' | 'preview' | 'issue' | 'rotate' | 'revoke' | 'list' | 'get'
>;

/** The names of `VaubaanMissions`, for the composition root and the tests. */
export const VAUBAAN_MISSION_METHODS = [
  'issuanceContext',
  'preview',
  'issue',
  'rotate',
  'revoke',
  'list',
  'get',
] as const satisfies readonly (keyof VaubaanMissions)[];

/** One service's catalog as the tools show it: explicit ids and macro-actions, no behaviour. */
export interface ServiceCatalog {
  readonly service: string;
  readonly service_label: string;
  /** The plugin derives the environment from the call: env-qualified ids need no labelled resource. */
  readonly derives_env: boolean;
  /** The whole catalog as explicit `RiskId`s, catalog order. */
  readonly risks: readonly CatalogRisk[];
  /** The catalog's macro-actions, then "Anything else" holding the fallback (`macroActionsOf`). */
  readonly macro_actions: readonly MacroAction[];
}

/** The catalogs of the plugins the instance ships: static data, read from the registry. */
export interface VaubaanCatalog {
  /** Service ids, registry order. */
  services(): readonly string[];
  get(service: string): ServiceCatalog | null;
}

export interface VaubaanModuleDeps {
  readonly missions: VaubaanMissions;
  readonly catalog: VaubaanCatalog;
  readonly logger: Logger;
}

/** The keys of `VaubaanModuleDeps`: the whole of what the module is given. */
export const VAUBAAN_DEPENDENCIES = [
  'missions',
  'catalog',
  'logger',
] as const satisfies readonly (keyof VaubaanModuleDeps)[];
