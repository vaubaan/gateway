/**
 * What an administrator, or an agent on a mission an administrator created, does to the
 * installed plugins (ADR plugins-activated-by-an-administrator-on-trial; spec
 * vaubaan-gateway §4.1 bis, §4.2 Administration › Plugins; intents
 * install-a-plugin-on-my-gateway). Every act is audited; nothing here runs the code of
 * an archive: the next start does, on trial (`installed.ts`).
 *
 * Trust: until signatures are verified (ADR plugin-signature-sets-the-trust-level, phase
 * 3), every archive is `unsigned`, and an unsigned archive is accepted only for an id
 * `plugins.allow_unsigned` names and that neither the image nor the catalog uses.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuditWriter } from '@vaubaan/gateway-core';
import { parseCatalogYaml } from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import type { Clock } from '../store/clock.ts';
import { toIso } from '../store/clock.ts';
import type {
  PluginVersionRecord,
  PluginVersionsRepo,
} from '../store/repositories/plugin-versions.ts';
import { InstallRefusal, storeArchive, type InstallRefusalCode } from './installed';
import { PINNED_CATALOG_FILE } from './loader';
import { readFile } from 'node:fs/promises';

/** Previous versions kept per plugin, besides the active one and the image's (D10). */
export const PREVIOUS_VERSIONS_KEPT = 2;

/** Who acts: a person, or the agent of a mission that person created. */
export interface PluginActor {
  readonly userId: string;
  readonly viaMissionId?: string;
}

export type UploadRefusalCode =
  InstallRefusalCode | 'no-data-directory' | 'unsigned-not-allowed' | 'reserved-id';

export type PluginActRefusalCode =
  'not-found' | 'wrong-state' | 'confirmation-mismatch' | 'accounts-depend';

export type UploadResult =
  | { readonly ok: true; readonly version: PluginVersionRecord }
  | { readonly ok: false; readonly code: UploadRefusalCode; readonly message: string };

export type PluginActResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PluginActRefusalCode; readonly message: string };

/** What the activation page shows before an administrator confirms. */
export interface ActivationView {
  readonly version: PluginVersionRecord;
  /** The version running now, `null` when the plugin is not registered. */
  readonly running: { readonly version: string; readonly origin: string } | null;
  /** Risk ids of the version that the running one does not have. */
  readonly added: readonly string[];
  /** Risk ids the version marks deprecated. */
  readonly deprecated: readonly string[];
  /** Risk ids the running version has and this one does not know (going back). */
  readonly unknownToIt: readonly string[];
  /** Accounts connected to the service. */
  readonly accounts: number;
}

export interface PluginInstallDeps {
  readonly versions: PluginVersionsRepo;
  /** `<data dir>/plugins`; `null` for a store in memory. */
  readonly dir: string | null;
  readonly sdkVersion: string;
  /** `plugins.allow_unsigned`. */
  readonly allowUnsigned: ReadonlySet<string>;
  /** Ids only a Vaubaan signature may carry: the image's plugins and the catalog's. */
  readonly reservedIds: () => ReadonlySet<string>;
  /** The plugin registered now, by id: its version, origin and risk ids. */
  readonly running: (pluginId: string) => {
    readonly version: string;
    readonly origin: string;
    readonly riskIds: readonly string[];
  } | null;
  /** Whether the image or the operator's directory provides a version of the plugin. */
  readonly providedOtherwise: (pluginId: string) => boolean;
  readonly accountsOf: (pluginId: string) => Promise<number>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface PluginInstallService {
  upload(bytes: Uint8Array, actor: PluginActor): Promise<UploadResult>;
  activationView(digest: string): Promise<ActivationView | null>;
  /** Marks a version for a trial at the next start; `typedId` must be the plugin's id. */
  activate(digest: string, typedId: string, actor: PluginActor): Promise<PluginActResult>;
  refuse(digest: string, actor: PluginActor): Promise<PluginActResult>;
  /** The plugin goes back to the image's (or the operator's) version, or leaves. */
  followImage(pluginId: string, actor: PluginActor): Promise<PluginActResult>;
  list(): Promise<readonly PluginVersionRecord[]>;
}

export function createPluginInstallService(deps: PluginInstallDeps): PluginInstallService {
  async function audit(
    actor: PluginActor,
    act: 'plugin-uploaded' | 'plugin-activated' | 'plugin-refused' | 'plugin-followed-image',
    objectId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    try {
      await deps.audit.write({
        kind: 'admin',
        ts: toIso(deps.clock.now()),
        user_id: actor.userId,
        act,
        object: { type: 'plugin', id: objectId },
        before,
        after,
        ...(actor.viaMissionId !== undefined ? { via_mission_id: actor.viaMissionId } : {}),
      });
    } catch (err) {
      deps.logger.error('audit entry not written for a plugin act', { act, object: objectId, err });
    }
  }

  function summary(v: PluginVersionRecord): Record<string, unknown> {
    return {
      plugin: v.pluginId,
      version: v.version,
      digest: v.digest,
      state: v.state,
      trust: v.trust,
    };
  }

  return {
    async upload(bytes, actor) {
      if (deps.dir === null) {
        return {
          ok: false,
          code: 'no-data-directory',
          message: 'this instance keeps its store in memory: nothing can be installed',
        };
      }
      let stored;
      try {
        stored = await storeArchive(deps.dir, bytes, { sdkVersion: deps.sdkVersion });
      } catch (err) {
        if (err instanceof InstallRefusal)
          return { ok: false, code: err.code, message: err.message };
        throw err;
      }
      // Phase 2: no signature is verified yet, so every archive is unsigned.
      if (deps.reservedIds().has(stored.pluginId)) {
        await rm(stored.path, { recursive: true, force: true }).catch(() => undefined);
        return {
          ok: false,
          code: 'reserved-id',
          message: `'${stored.pluginId}' is a plugin of the image or the catalog: only a version signed by Vaubaan may replace it`,
        };
      }
      if (!deps.allowUnsigned.has(stored.pluginId)) {
        await rm(stored.path, { recursive: true, force: true }).catch(() => undefined);
        return {
          ok: false,
          code: 'unsigned-not-allowed',
          message: `'${stored.pluginId}' is not signed, and plugins.allow_unsigned does not name it`,
        };
      }
      const version = await deps.versions.addPending({
        digest: stored.digest,
        pluginId: stored.pluginId,
        version: stored.version,
        packageName: stored.packageName,
        sdkRange: stored.sdkRange,
        trust: 'unsigned',
        signer: null,
        riskIds: stored.riskIds,
        uploadedBy: actor.userId,
        viaMissionId: actor.viaMissionId ?? null,
      });
      await audit(actor, 'plugin-uploaded', version.digest, null, summary(version));
      return { ok: true, version };
    },

    async activationView(digest) {
      const version = await deps.versions.get(digest);
      if (version === null) return null;
      const running = deps.running(version.pluginId);
      const runningIds = new Set(running?.riskIds ?? []);
      const ids = new Set(version.riskIds);
      let deprecated: string[] = [];
      if (deps.dir !== null) {
        try {
          const text = await readFile(
            join(/* turbopackIgnore: true */ deps.dir, digest, PINNED_CATALOG_FILE),
            'utf8',
          );
          deprecated = parseCatalogYaml(text)
            .catalog.risks.filter((risk) => risk.deprecated === true)
            .map((risk) => risk.id);
        } catch {
          deprecated = [];
        }
      }
      return {
        version,
        running: running === null ? null : { version: running.version, origin: running.origin },
        added: version.riskIds.filter((id) => !runningIds.has(id)),
        deprecated,
        unknownToIt: [...runningIds].filter((id) => !ids.has(id)),
        accounts: await deps.accountsOf(version.pluginId),
      };
    },

    async activate(digest, typedId, actor) {
      const version = await deps.versions.get(digest);
      if (version === null) return { ok: false, code: 'not-found', message: 'no such version' };
      if (typedId.trim() !== version.pluginId) {
        return {
          ok: false,
          code: 'confirmation-mismatch',
          message: `type '${version.pluginId}' to activate it`,
        };
      }
      const marked = await deps.versions.markTrial(digest, actor.userId);
      if (!marked.ok) {
        return {
          ok: false,
          code: marked.state === null ? 'not-found' : 'wrong-state',
          message: `a version ${marked.state ?? 'unknown'} cannot be activated`,
        };
      }
      await audit(actor, 'plugin-activated', digest, summary(version), {
        ...summary(version),
        state: 'trial',
      });
      return { ok: true };
    },

    async refuse(digest, actor) {
      const version = await deps.versions.get(digest);
      if (version === null) return { ok: false, code: 'not-found', message: 'no such version' };
      const refused = await deps.versions.refuse(digest, actor.userId);
      if (!refused.ok) {
        return {
          ok: false,
          code: 'wrong-state',
          message: `a version ${version.state} cannot be refused`,
        };
      }
      if (deps.dir !== null)
        await rm(join(/* turbopackIgnore: true */ deps.dir, digest), {
          recursive: true,
          force: true,
        });
      await audit(actor, 'plugin-refused', digest, summary(version), {
        ...summary(version),
        state: 'refused',
      });
      return { ok: true };
    },

    async followImage(pluginId, actor) {
      if (!deps.providedOtherwise(pluginId) && (await deps.accountsOf(pluginId)) > 0) {
        return {
          ok: false,
          code: 'accounts-depend',
          message: `accounts use '${pluginId}' and neither the image nor the plugins directory provides it: disconnect them first`,
        };
      }
      const changed = await deps.versions.followImage(pluginId, actor.userId);
      if (!changed)
        return { ok: false, code: 'wrong-state', message: 'nothing is installed for it' };
      const removed = await deps.versions.prune(PREVIOUS_VERSIONS_KEPT, actor.userId);
      if (deps.dir !== null) {
        for (const digest of removed) {
          await rm(join(/* turbopackIgnore: true */ deps.dir, digest), {
            recursive: true,
            force: true,
          });
        }
      }
      await audit(actor, 'plugin-followed-image', pluginId, null, { plugin: pluginId });
      return { ok: true };
    },

    async list() {
      return deps.versions.list();
    },
  };
}
