/**
 * Everything the host side of the `vaubaan` plugin is built from (spec §4.1 bis;
 * ADR platform-management-is-a-plugin-on-the-execution-door).
 *
 * **The hard deny is this file.** The management tools never answer a request,
 * open a gate, extend a budget, reset a period, touch an account, a share or a
 * group, or call another service's tool — whatever the arguments say. That is
 * not enforced by checks inside the acts: the module is *not handed* anything
 * that could do it. `VaubaanModuleDeps` lists two ports — next to a logger —
 * and nothing else (and, for the two plugin acts, a third, `plugins`, below):
 *
 *   missions   ten methods of the mission service: read, preview, issue,
 *              the edit of a mission (`editView`, `previewEdit`, `edit`: the
 *              creator's "Edit mission", one version each), rotate, revoke —
 *              not `setGate`, not `setLimits`, not `changePermissions`, not
 *              `duplicate`, not `verifyToken`
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
import type { PluginStatusAnswer } from './plugin-acts';

/**
 * The part of the mission service the acts may use, each method called with
 * the calling mission's creator as the actor. `issue`, `edit`, `rotate` and
 * `revoke` receive the calling mission, so a mission records who issued it, a
 * version who wrote it, and the audit names it. An edit reaches what the
 * creator's own "Edit mission" reaches — bounded by their authority now — and
 * nothing a gate, a limit or a permission request alone would (ADR amendment
 * 2026-11-16).
 */
export type VaubaanMissions = Pick<
  MissionService,
  | 'issuanceContext'
  | 'preview'
  | 'issue'
  | 'editView'
  | 'previewEdit'
  | 'edit'
  | 'rotate'
  | 'revoke'
  | 'list'
  | 'get'
>;

/** The names of `VaubaanMissions`, for the composition root and the tests. */
export const VAUBAAN_MISSION_METHODS = [
  'issuanceContext',
  'preview',
  'issue',
  'editView',
  'previewEdit',
  'edit',
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

/**
 * The plugins of the instance as the plugin acts may use them (ADR
 * plugins-activated-by-an-administrator-on-trial): whether the creator is an
 * administrator, an upload that stays inert, the status. Nothing that activates,
 * refuses, rolls back or removes a plugin, nor changes the trusted signers.
 */
export interface VaubaanPlugins {
  isAdministrator(userId: string): Promise<boolean>;
  upload(
    bytes: Uint8Array,
    actor: { readonly userId: string; readonly viaMissionId: string },
  ): Promise<
    | {
        readonly ok: true;
        readonly version: {
          readonly pluginId: string;
          readonly version: string;
          readonly digest: string;
        };
      }
    | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  activationUrl(digest: string): string;
  status(): Promise<PluginStatusAnswer>;
}

export interface VaubaanModuleDeps {
  readonly missions: VaubaanMissions;
  readonly catalog: VaubaanCatalog;
  readonly plugins: VaubaanPlugins;
  readonly logger: Logger;
}

/** The keys of `VaubaanModuleDeps`: the whole of what the module is given. */
export const VAUBAAN_DEPENDENCIES = [
  'missions',
  'catalog',
  'plugins',
  'logger',
] as const satisfies readonly (keyof VaubaanModuleDeps)[];
