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
import { keyIdOf, type TrustedKey } from '@vaubaan/plugin-sdk/archive';

import type {
  PluginSignerRecord,
  PluginSignersRepo,
} from '../store/repositories/plugin-signers.ts';

import { InstallRefusal, storeArchive, type InstallRefusalCode } from './installed';
import { admissionProblem, trustOf, type AdmissionCode } from './trust';
import type { CatalogFetch, CatalogFetchCode } from './catalog';
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
  | InstallRefusalCode
  | 'no-data-directory'
  | AdmissionCode
  | CatalogFetchCode
  | 'not-the-catalog-version';

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
  /** The signers the administrators named as trusted (`plugin_signers`). */
  readonly signers: PluginSignersRepo;
  /** Tells every administrator a signer was added. */
  readonly notifySignerAdded: (name: string) => void;
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
  /** Downloads a version's archive from the catalog (`catalog.ts`); `null` when there is none. */
  readonly catalog: ((pluginId: string, version: string) => Promise<CatalogFetch>) | null;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

export type SignerRefusalCode =
  'not-a-key' | 'name-invalid' | 'confirmation-mismatch' | 'already-trusted' | 'not-found';

export type SignerResult =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly code: SignerRefusalCode; readonly message: string };

export interface PluginInstallService {
  /** The signers trusted for private plugins, with the installed versions each signed. */
  listSigners(): Promise<readonly (PluginSignerRecord & { readonly versions: number })[]>;
  /** Trusts a company key, named; `typedName` must be the name. Notifies every administrator. */
  addSigner(
    input: { readonly name: string; readonly publicKeyPem: string; readonly typedName: string },
    actor: PluginActor,
  ): Promise<SignerResult>;
  /**
   * No longer trusts a key; `typedName` must be its name. A version it signed is refused
   * from the next start, and the plugin falls back to the image's or the pin.
   */
  removeSigner(keyId: string, typedName: string, actor: PluginActor): Promise<SignerResult>;
  upload(bytes: Uint8Array, actor: PluginActor): Promise<UploadResult>;
  /**
   * Downloads a version from the catalog and keeps it pending, as an upload would — only if
   * its signature is the catalog's and it is that id at that version; else nothing is kept.
   */
  installFromCatalog(pluginId: string, version: string, actor: PluginActor): Promise<UploadResult>;
  activationView(digest: string): Promise<ActivationView | null>;
  /** Marks a version for a trial at the next start; `typedId` must be the plugin's id. */
  activate(digest: string, typedId: string, actor: PluginActor): Promise<PluginActResult>;
  refuse(digest: string, actor: PluginActor): Promise<PluginActResult>;
  /** The plugin goes back to the image's (or the operator's) version, or leaves. */
  followImage(pluginId: string, actor: PluginActor): Promise<PluginActResult>;
  list(): Promise<readonly PluginVersionRecord[]>;
}

export function createPluginInstallService(deps: PluginInstallDeps): PluginInstallService {
  async function trustedKeys(): Promise<TrustedKey[]> {
    return (await deps.signers.list()).map((s) => ({ name: s.name, publicKeyPem: s.publicKeyPem }));
  }

  async function audit(
    actor: PluginActor,
    act:
      | 'plugin-uploaded'
      | 'plugin-activated'
      | 'plugin-refused'
      | 'plugin-followed-image'
      | 'plugin-signer-added'
      | 'plugin-signer-removed',
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

  function noDataDirectory(): UploadResult {
    return {
      ok: false,
      code: 'no-data-directory',
      message: 'this instance keeps its store in memory: nothing can be installed',
    };
  }

  /**
   * Stores an archive, checks it, and keeps it pending. `expected`, for a catalog download:
   * the archive must carry the catalog's signature and be that id at that version, or it
   * is deleted and nothing is recorded.
   */
  async function admit(
    bytes: Uint8Array,
    actor: PluginActor,
    expected: {
      readonly pluginId: string;
      readonly version: string;
      readonly source: string;
    } | null,
  ): Promise<UploadResult> {
    if (deps.dir === null) return noDataDirectory();
    let stored;
    try {
      stored = await storeArchive(deps.dir, bytes, { sdkVersion: deps.sdkVersion });
    } catch (err) {
      if (err instanceof InstallRefusal) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
    // Only a folder this upload wrote, and no recorded version uses: the same digest may be
    // a version already kept, whose folder a refusal of these bytes must never delete.
    const discard = async (): Promise<void> => {
      if (!stored.created || (await deps.versions.get(stored.digest)) !== null) return;
      await rm(stored.path, { recursive: true, force: true }).catch(() => undefined);
    };
    const verdict = trustOf(stored.files, { trustedKeys: await trustedKeys() });
    if (expected !== null) {
      if (verdict.level !== 'vaubaan') {
        await discard();
        return {
          ok: false,
          code: 'signature-invalid',
          message: `the archive downloaded from the catalog is not signed by the catalog (${verdict.level}); nothing was kept`,
        };
      }
      if (stored.pluginId !== expected.pluginId || stored.version !== expected.version) {
        await discard();
        return {
          ok: false,
          code: 'not-the-catalog-version',
          message: `the catalog served ${stored.pluginId} ${stored.version}, not ${expected.pluginId} ${expected.version}; nothing was kept`,
        };
      }
    }
    const problem = admissionProblem(stored.pluginId, verdict, {
      reservedIds: deps.reservedIds(),
      allowUnsigned: deps.allowUnsigned,
    });
    if (problem !== null) {
      await discard();
      return { ok: false, code: problem.code, message: problem.message };
    }
    const version = await deps.versions.addPending({
      digest: stored.digest,
      pluginId: stored.pluginId,
      version: stored.version,
      packageName: stored.packageName,
      sdkRange: stored.sdkRange,
      trust: verdict.level as 'vaubaan' | 'signer' | 'unsigned',
      signer: verdict.level === 'signer' ? verdict.signer : null,
      riskIds: stored.riskIds,
      uploadedBy: actor.userId,
      viaMissionId: actor.viaMissionId ?? null,
    });
    await audit(actor, 'plugin-uploaded', version.digest, null, {
      ...summary(version),
      ...(expected !== null ? { from: 'catalog', source: expected.source } : {}),
    });
    return { ok: true, version };
  }

  return {
    upload: (bytes, actor) => admit(bytes, actor, null),

    async installFromCatalog(pluginId, version, actor) {
      if (deps.dir === null) return noDataDirectory();
      if (deps.catalog === null) {
        return {
          ok: false,
          code: 'catalog-unreachable',
          message: 'this instance reads no catalog',
        };
      }
      const fetched = await deps.catalog(pluginId, version);
      if (!fetched.ok) return fetched;
      return admit(fetched.bytes, actor, { pluginId, version, source: fetched.url });
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

    async listSigners() {
      const versions = await deps.versions.list();
      return (await deps.signers.list()).map((signer) => ({
        ...signer,
        versions: versions.filter(
          (v) => v.trust === 'signer' && v.signer === signer.name && v.state !== 'removed',
        ).length,
      }));
    },

    async addSigner(input, actor) {
      const name = input.name.trim();
      if (name === '' || name.length > 80) {
        return { ok: false, code: 'name-invalid', message: 'a name of 1 to 80 characters' };
      }
      if (input.typedName.trim() !== name) {
        return { ok: false, code: 'confirmation-mismatch', message: `type '${name}' to trust it` };
      }
      let keyId: string;
      try {
        keyId = keyIdOf(input.publicKeyPem);
      } catch {
        return {
          ok: false,
          code: 'not-a-key',
          message: 'not an ed25519 public key in PEM (the .pub.pem vaubaan-plugin keygen writes)',
        };
      }
      const added = await deps.signers.add({
        keyId,
        name,
        publicKeyPem: input.publicKeyPem.trim() + '\n',
        addedBy: actor.userId,
      });
      if (!added) {
        return {
          ok: false,
          code: 'already-trusted',
          message: 'this key or this name is already trusted',
        };
      }
      await audit(actor, 'plugin-signer-added', keyId, null, { name, key_id: keyId });
      deps.notifySignerAdded(name);
      return { ok: true, keyId };
    },

    async removeSigner(keyId, typedName, actor) {
      const signer = await deps.signers.get(keyId);
      if (signer === null) return { ok: false, code: 'not-found', message: 'no such signer' };
      if (typedName.trim() !== signer.name) {
        return {
          ok: false,
          code: 'confirmation-mismatch',
          message: `type '${signer.name}' to remove it`,
        };
      }
      await deps.signers.remove(keyId);
      await audit(
        actor,
        'plugin-signer-removed',
        keyId,
        { name: signer.name, key_id: keyId },
        null,
      );
      return { ok: true, keyId };
    },
  };
}
