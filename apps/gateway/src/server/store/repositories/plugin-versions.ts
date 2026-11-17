/**
 * The versions of installed plugins (migration 0041; ADR
 * plugins-activated-by-an-administrator-on-trial; handbook plugin-loading). One row per
 * archive, by the sha256 of its bytes; its files are on the data volume, never here.
 */

import type { Iso } from '../types.ts';
import { nowIso, parseEnum, type RepoContext } from './context.ts';
import { PLUGIN_TRUSTS, PLUGIN_VERSION_STATES } from './enums.ts';

export type PluginVersionState =
  'pending' | 'trial' | 'active' | 'previous' | 'failed' | 'refused' | 'removed';
export type PluginTrust = 'unsigned' | 'vaubaan' | 'signer';

/** The states of a version kept on the volume: what an administrator can go back to. */
export const KEPT_STATES: ReadonlySet<PluginVersionState> = new Set([
  'trial',
  'active',
  'previous',
]);

export interface PluginVersionRecord {
  readonly digest: string;
  readonly pluginId: string;
  readonly version: string;
  readonly packageName: string;
  readonly sdkRange: string;
  readonly trust: PluginTrust;
  /** The signer's name when `trust` is `signer`. */
  readonly signer: string | null;
  readonly riskIds: readonly string[];
  readonly state: PluginVersionState;
  readonly failure: string | null;
  readonly uploadedAt: Iso;
  /** A user id, or an actor constant. */
  readonly uploadedBy: string;
  /** The mission whose agent uploaded it, when one did. */
  readonly viaMissionId: string | null;
  readonly changedAt: Iso;
  readonly changedBy: string;
}

export interface NewPluginVersion {
  readonly digest: string;
  readonly pluginId: string;
  readonly version: string;
  readonly packageName: string;
  readonly sdkRange: string;
  readonly trust: PluginTrust;
  readonly signer: string | null;
  readonly riskIds: readonly string[];
  readonly uploadedBy: string;
  readonly viaMissionId: string | null;
}

/** What one start made of a version (`loadInstalled`'s outcomes). */
export type PluginStartOutcome =
  | { readonly digest: string; readonly outcome: 'activated'; readonly replaced: string | null }
  | { readonly digest: string; readonly outcome: 'loaded' }
  | { readonly digest: string; readonly outcome: 'failed'; readonly failure: string };

/** A change refused because the version is not in a state that allows it. */
export interface PluginVersionConflict {
  readonly ok: false;
  readonly state: PluginVersionState | null;
}

export interface PluginVersionsRepo {
  get(digest: string): Promise<PluginVersionRecord | null>;
  /** Every version, newest change first. */
  list(): Promise<readonly PluginVersionRecord[]>;
  /** The versions the start loads: `trial` and `active`. */
  forStart(): Promise<readonly PluginVersionRecord[]>;
  /**
   * Records an upload as `pending`. The same bytes again: a `refused`, `removed` or
   * `failed` version becomes pending again; any other is returned as it is.
   */
  addPending(version: NewPluginVersion): Promise<PluginVersionRecord>;
  /**
   * Marks a `pending`, `previous` or `failed` version for a trial at the next start; a
   * trial of the same plugin already marked goes back to `pending`.
   */
  markTrial(digest: string, by: string): Promise<{ ok: true } | PluginVersionConflict>;
  /** A `pending` version refused. */
  refuse(digest: string, by: string): Promise<{ ok: true } | PluginVersionConflict>;
  /**
   * The plugin follows the image again: its `active` version becomes `previous`, a
   * `trial` goes back to `pending`. Returns whether anything changed.
   */
  followImage(pluginId: string, by: string): Promise<boolean>;
  /** Records what a start made of its trials and actives, in one transaction. */
  recordStart(outcomes: readonly PluginStartOutcome[], by: string): Promise<void>;
  /**
   * Keeps the `keep` latest `previous` versions of each plugin and marks the others
   * `removed`; returns their digests, whose folders the caller deletes.
   */
  prune(keep: number, by: string): Promise<readonly string[]>;
  /** The risk ids of every kept version: the store accepts them in a mission. */
  keptRiskIds(): Promise<ReadonlySet<string>>;
}

interface Row {
  digest: string;
  plugin_id: string;
  version: string;
  package_name: string;
  sdk_range: string;
  trust: string;
  signer: string | null;
  risk_ids_json: string;
  state: string;
  failure: string | null;
  uploaded_at: string;
  uploaded_by: string;
  via_mission_id: string | null;
  changed_at: string;
  changed_by: string;
}

function toRecord(row: Row): PluginVersionRecord {
  const ids: unknown = JSON.parse(row.risk_ids_json);
  return {
    digest: row.digest,
    pluginId: row.plugin_id,
    version: row.version,
    packageName: row.package_name,
    sdkRange: row.sdk_range,
    trust: parseEnum(PLUGIN_TRUSTS, row.trust, 'plugin_versions.trust'),
    signer: row.signer,
    riskIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
    state: parseEnum(PLUGIN_VERSION_STATES, row.state, 'plugin_versions.state'),
    failure: row.failure,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by,
    viaMissionId: row.via_mission_id,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
  };
}

export function createPluginVersionsRepo(ctx: RepoContext): PluginVersionsRepo {
  const { db } = ctx;
  const one = db.prepare<[string], Row>('SELECT * FROM plugin_versions WHERE digest = ?');
  const all = db.prepare<[], Row>(
    'SELECT * FROM plugin_versions ORDER BY changed_at DESC, plugin_id, version',
  );
  const starting = db.prepare<[], Row>(
    "SELECT * FROM plugin_versions WHERE state IN ('trial', 'active') ORDER BY plugin_id",
  );
  const insert = db.prepare<
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string,
      string,
      string,
      string | null,
      string,
      string,
    ]
  >(
    `INSERT INTO plugin_versions (digest, plugin_id, version, package_name, sdk_range, trust,
       signer, risk_ids_json, state, failure, uploaded_at, uploaded_by, via_mission_id,
       changed_at, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?)`,
  );
  const setState = db.prepare<[string, string | null, string, string, string]>(
    'UPDATE plugin_versions SET state = ?, failure = ?, changed_at = ?, changed_by = ? WHERE digest = ?',
  );
  const trialOf = db.prepare<[string], Row>(
    "SELECT * FROM plugin_versions WHERE plugin_id = ? AND state = 'trial'",
  );
  const activeOf = db.prepare<[string], Row>(
    "SELECT * FROM plugin_versions WHERE plugin_id = ? AND state = 'active'",
  );
  const previousNewestFirst = db.prepare<[], Row>(
    "SELECT * FROM plugin_versions WHERE state = 'previous' ORDER BY plugin_id, changed_at DESC",
  );
  const kept = db.prepare<[], { risk_ids_json: string }>(
    "SELECT risk_ids_json FROM plugin_versions WHERE state IN ('trial', 'active', 'previous')",
  );

  const addPending = db.transaction((v: NewPluginVersion, now: string): Row => {
    const existing = one.get(v.digest);
    if (existing === undefined) {
      insert.run(
        v.digest,
        v.pluginId,
        v.version,
        v.packageName,
        v.sdkRange,
        v.trust,
        v.signer,
        JSON.stringify([...v.riskIds]),
        now,
        v.uploadedBy,
        v.viaMissionId,
        now,
        v.uploadedBy,
      );
    } else if (['refused', 'removed', 'failed'].includes(existing.state)) {
      setState.run('pending', null, now, v.uploadedBy, v.digest);
    }
    return one.get(v.digest) as Row;
  });

  const markTrial = db.transaction(
    (digest: string, by: string, now: string): { ok: true } | PluginVersionConflict => {
      const row = one.get(digest);
      if (row === undefined) return { ok: false, state: null };
      if (!['pending', 'previous', 'failed'].includes(row.state)) {
        return { ok: false, state: parseEnum(PLUGIN_VERSION_STATES, row.state, 'state') };
      }
      const other = trialOf.get(row.plugin_id);
      if (other !== undefined) setState.run('pending', null, now, by, other.digest);
      setState.run('trial', null, now, by, digest);
      return { ok: true };
    },
  );

  const refuse = db.transaction(
    (digest: string, by: string, now: string): { ok: true } | PluginVersionConflict => {
      const row = one.get(digest);
      if (row === undefined) return { ok: false, state: null };
      if (row.state !== 'pending') {
        return { ok: false, state: parseEnum(PLUGIN_VERSION_STATES, row.state, 'state') };
      }
      setState.run('refused', null, now, by, digest);
      return { ok: true };
    },
  );

  const followImage = db.transaction((pluginId: string, by: string, now: string): boolean => {
    let changed = false;
    const trial = trialOf.get(pluginId);
    if (trial !== undefined) {
      setState.run('pending', null, now, by, trial.digest);
      changed = true;
    }
    const active = activeOf.get(pluginId);
    if (active !== undefined) {
      setState.run('previous', null, now, by, active.digest);
      changed = true;
    }
    return changed;
  });

  const recordStart = db.transaction(
    (outcomes: readonly PluginStartOutcome[], by: string, now: string) => {
      for (const o of outcomes) {
        if (o.outcome === 'failed') setState.run('failed', o.failure, now, by, o.digest);
        if (o.outcome === 'activated') {
          if (o.replaced !== null) setState.run('previous', null, now, by, o.replaced);
          setState.run('active', null, now, by, o.digest);
        }
      }
    },
  );

  const prune = db.transaction((keep: number, by: string, now: string): string[] => {
    const seen = new Map<string, number>();
    const removed: string[] = [];
    for (const row of previousNewestFirst.all()) {
      const count = (seen.get(row.plugin_id) ?? 0) + 1;
      seen.set(row.plugin_id, count);
      if (count > keep) {
        setState.run('removed', null, now, by, row.digest);
        removed.push(row.digest);
      }
    }
    return removed;
  });

  return {
    async get(digest) {
      const row = one.get(digest);
      return row === undefined ? null : toRecord(row);
    },
    async list() {
      return all.all().map(toRecord);
    },
    async forStart() {
      return starting.all().map(toRecord);
    },
    async addPending(version) {
      return toRecord(addPending(version, nowIso(ctx)));
    },
    async markTrial(digest, by) {
      return markTrial(digest, by, nowIso(ctx));
    },
    async refuse(digest, by) {
      return refuse(digest, by, nowIso(ctx));
    },
    async followImage(pluginId, by) {
      return followImage(pluginId, by, nowIso(ctx));
    },
    async recordStart(outcomes, by) {
      recordStart(outcomes, by, nowIso(ctx));
    },
    async prune(keep, by) {
      return prune(keep, by, nowIso(ctx));
    },
    async keptRiskIds() {
      const ids = new Set<string>();
      for (const row of kept.all()) {
        const parsed: unknown = JSON.parse(row.risk_ids_json);
        if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string') ids.add(id);
      }
      return ids;
    },
  };
}
