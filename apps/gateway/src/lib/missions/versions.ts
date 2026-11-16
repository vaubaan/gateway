/**
 * The versions of a mission's configuration (spec §4.2 "History"), as pure functions:
 * the configuration a version keeps (`MissionVersionConfig`), whether two are the same,
 * what moved between two of them, in the words of an edit, and the draft that restores
 * one under the creator's authority now.
 *
 * A version keeps what an edit may move — name, end, period, accounts with their
 * resource sets, policy lines — and the trust levels the screen is redrawn from. Keys,
 * teammates and counters are no configuration: a rollback resets no usage and rotates no
 * key.
 *
 * Browser-safe, no IO: the store writes the configuration and its changes with it, the
 * mission page words them, and the restore is judged by `judgeEdit`, issuance's own
 * check on what moves.
 */
import type { MissionChangedEventDetails, MissionPolicyEntry, RiskId } from '@vaubaan/shared';

import type {
  DraftAccount,
  DraftResourceSet,
  IssuanceAccount,
  MissionDraft,
  DraftPeriod,
  PreviewIssue,
} from './model';
import {
  changeSummaryOf,
  diffSnapshots,
  draftAccountOf,
  judgeEdit,
  type EditJudgement,
  type MissionChanges,
  type MissionSnapshot,
  type MissionSnapshotAccount,
} from './mission-edit';
import type { PreviewContext } from './preview';

/** Why a version was written; `before-versions` is the one the migration wrote. */
export const MISSION_VERSION_CAUSES = [
  'issued',
  'before-versions',
  'edit',
  'permission-request',
  'resource-created',
  'resources-discovered',
  'claim-granted',
  'rollback',
] as const;
export type MissionVersionCause = (typeof MISSION_VERSION_CAUSES)[number];

/** Who wrote a version: a person, a mission through its `vaubaan` account, or the gateway. */
export const MISSION_VERSION_AUTHOR_KINDS = ['person', 'mission', 'gateway'] as const;
export type MissionVersionAuthorKind = (typeof MISSION_VERSION_AUTHOR_KINDS)[number];

/** One resource set as a version keeps it. */
export interface MissionVersionSet {
  readonly id: string;
  readonly position: number;
  readonly future: boolean;
  readonly env: string | null;
  /** Legacy (migration 0033): the set mixed environments. */
  readonly mixed_env: boolean;
  readonly resource_ids: readonly string[];
  /** The trust levels the screen is redrawn from; `{}` for none. */
  readonly trust_levels: Readonly<Record<string, string>>;
}

export interface MissionVersionAccount {
  readonly account_id: string;
  readonly resource_sets: readonly MissionVersionSet[];
}

/** A line as a version keeps it: always in a set. */
export type MissionVersionLine = MissionPolicyEntry & { readonly resource_set_id: string };

/** A mission's configuration, whole (`mission_versions.config_json`). */
export interface MissionVersionConfig {
  readonly name: string;
  readonly expires_at: string | null;
  readonly period: DraftPeriod;
  readonly accounts: readonly MissionVersionAccount[];
  readonly policy: readonly MissionVersionLine[];
}

function sortedRecord(record: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The configuration in one string, whatever the order of its rows or of the keys of its
 * objects: two configurations are the same when their canonical strings are.
 */
export function canonicalConfig(config: MissionVersionConfig): string {
  const at = config.expires_at === null ? null : Date.parse(config.expires_at);
  return JSON.stringify([
    config.name,
    at,
    config.period.kind === 'one-off' ? null : config.period.length_seconds,
    [...config.accounts]
      .sort((a, b) => a.account_id.localeCompare(b.account_id))
      .map((c) => [
        c.account_id,
        [...c.resource_sets]
          .sort((a, b) => a.position - b.position)
          .map((set) => [
            set.id,
            set.position,
            set.future,
            set.env,
            set.mixed_env,
            [...set.resource_ids].sort(),
            sortedRecord(set.trust_levels),
          ]),
      ]),
    [...config.policy]
      .sort(
        (a, b) =>
          a.resource_set_id.localeCompare(b.resource_set_id) || a.risk_id.localeCompare(b.risk_id),
      )
      .map((p) => [
        p.resource_set_id,
        p.risk_id,
        p.quota,
        p.rate_limit.max,
        p.rate_limit.window_seconds,
        p.gate,
      ]),
  ]);
}

export function sameConfig(a: MissionVersionConfig, b: MissionVersionConfig): boolean {
  return canonicalConfig(a) === canonicalConfig(b);
}

/** What the words of a change name an account by; absent, its id. */
export interface AccountNames {
  readonly service: string;
  readonly display_name: string;
}

/** The configuration as the edit's snapshot, so that `diffSnapshots` reads it. */
export function snapshotOfConfig(
  config: MissionVersionConfig,
  namesOf: (accountId: string) => AccountNames | undefined = () => undefined,
): MissionSnapshot {
  return {
    name: config.name,
    expires_at: config.expires_at,
    period: config.period,
    accounts: config.accounts.map((c): MissionSnapshotAccount => {
      const names = namesOf(c.account_id);
      return {
        account_id: c.account_id,
        service: names?.service ?? '',
        display_name: names?.display_name ?? c.account_id,
        resource_sets: c.resource_sets.map((set) => ({
          key: set.id,
          id: set.id,
          position: set.position,
          future: set.future,
          env: set.env,
          resource_ids: [...set.resource_ids],
          policy: config.policy.filter((p) => p.resource_set_id === set.id),
          ...(Object.keys(set.trust_levels).length > 0 ? { trust_levels: set.trust_levels } : {}),
        })),
      };
    }),
  };
}

/** What moved from one version to the next, with the accounts named. */
export function changesBetween(
  before: MissionVersionConfig,
  after: MissionVersionConfig,
  namesOf?: (accountId: string) => AccountNames | undefined,
): MissionChanges {
  return diffSnapshots(snapshotOfConfig(before, namesOf), snapshotOfConfig(after, namesOf));
}

/**
 * The compact summary a version is listed with (`mission_versions.changes_json`): the
 * shape of a `mission-changed` session event, so that `missionChangeClauses` words it.
 * `null` for a first version, which has nothing before it.
 */
export function versionChanges(
  before: MissionVersionConfig | null,
  after: MissionVersionConfig,
): MissionChangedEventDetails | null {
  if (before === null) return null;
  return changeSummaryOf(changesBetween(before, after), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// The words of a version's changes, line by line
// ─────────────────────────────────────────────────────────────────────────────

/** How the detail lines name a permission and a resource. */
export interface VersionWords {
  readonly riskLabel: (riskId: RiskId) => string;
  readonly resourceName: (accountId: string, resourceId: string) => string;
}

function budgetWords(p: MissionPolicyEntry): string {
  const gate = p.gate === 'approval' ? 'asks first' : 'runs freely';
  return `${p.quota} per period, ${p.rate_limit.max} per ${p.rate_limit.window_seconds}s, ${gate}`;
}

function names(ids: readonly string[], nameOf: (id: string) => string): string {
  return ids.map(nameOf).join(', ');
}

/**
 * What a version changed, one line per change, for its expanded row on the mission
 * page: the name, the end, the accounts, the resources of each set, every permission
 * added, removed or changed with its values.
 */
export function versionDetailLines(changes: MissionChanges, words: VersionWords): string[] {
  const lines: string[] = [];
  if (changes.name) lines.push(`Renamed from “${changes.name.before}” to “${changes.name.after}”`);
  if (changes.expires_at) {
    const day = (at: string | null) => (at === null ? 'never' : at.slice(0, 10));
    lines.push(`Ends: ${day(changes.expires_at.before)} → ${day(changes.expires_at.after)}`);
  }
  for (const c of changes.accounts_added) lines.push(`Account added: ${c.display_name}`);
  for (const c of changes.accounts_removed) lines.push(`Account removed: ${c.display_name}`);
  const removedAccounts = new Set(changes.accounts_removed.map((c) => c.account_id));
  for (const r of changes.resources) {
    if (removedAccounts.has(r.account_id)) continue;
    const nameOf = (id: string) => words.resourceName(r.account_id, id);
    const where = `${r.display_name}, resource set ${r.position}`;
    if (r.future_before === null) lines.push(`${where}: added`);
    if (r.future_after === null) {
      lines.push(`${where}: removed`);
      continue;
    }
    if (r.added.length > 0) lines.push(`${where}: added ${names(r.added, nameOf)}`);
    if (r.removed.length > 0) lines.push(`${where}: removed ${names(r.removed, nameOf)}`);
    if (r.future_before !== null && r.future_before !== r.future_after) {
      lines.push(
        `${where}: ${r.future_after ? 'takes new resources from now on' : 'no longer takes new resources'}`,
      );
    }
  }
  for (const p of changes.permissions_added) {
    lines.push(`Permission added: ${words.riskLabel(p.risk_id)} (${budgetWords(p)})`);
  }
  for (const p of changes.permissions_removed) {
    lines.push(`Permission removed: ${words.riskLabel(p.risk_id)}`);
  }
  for (const c of changes.permissions_changed) {
    lines.push(`${words.riskLabel(c.risk_id)}: ${budgetWords(c.before)} → ${budgetWords(c.after)}`);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Restoring a version
// ─────────────────────────────────────────────────────────────────────────────

/** What a restore leaves out of the version, and why. */
export interface RestoreDropped {
  /** Accounts the creator no longer holds authority on, or revoked. */
  readonly accounts: readonly string[];
  /** Resources that no longer exist on their account (gone, or no longer discovered). */
  readonly resources: readonly { readonly account_id: string; readonly resource_id: string }[];
  /** Permissions the creator no longer holds, or that no longer pass on what is restored. */
  readonly permissions: readonly { readonly account_id: string; readonly risk_id: RiskId }[];
  /** The version's end has passed: the mission keeps its current one. */
  readonly expiry_kept: boolean;
}

export interface RestoreJudgement {
  readonly draft: MissionDraft;
  readonly judgement: EditJudgement;
  readonly dropped: RestoreDropped;
}

/** The issues that a line dropped from the draft settles. */
const LINE_DROPPING = new Set<PreviewIssue['code']>([
  'exceeds-authority',
  'unknown-risk',
  'unresolvable-env',
]);

/** How many times the restore drops refused lines and judges again. */
const MAX_PASSES = 3;

interface DraftLine {
  readonly accountIndex: number;
  readonly setIndex: number;
  readonly line: MissionVersionLine;
}

/**
 * The draft that brings `config` back, bounded by the creator's authority now
 * (`context.accounts`, the issuance context): an account they no longer hold or that is
 * revoked is left out, a resource that no longer exists (or is no longer discovered, or
 * is the instance's own) is left out, a line outside their authority is left out — each
 * said in `dropped`. A set the mission still has keeps its id (its counters follow it);
 * the period is the mission's (it is not editable); an end already past keeps the
 * current one. An account the mission carries now and that no longer serves it (lost)
 * is kept as it stands, whatever the version holds of it: a restore neither removes a
 * lost account nor brings one back (fail closed: its part stays lost, derived).
 *
 * Then judged as an edit (`judgeEdit`); a line the judgement still refuses for its risk
 * (authority, an unknown id, an environment no set holds) is dropped and the draft
 * judged again. What the judgement refuses for another reason stays refused.
 */
export function judgeRestore(
  context: PreviewContext,
  current: MissionSnapshot,
  config: MissionVersionConfig,
): RestoreJudgement {
  const droppedAccounts: string[] = [];
  const droppedResources: { account_id: string; resource_id: string }[] = [];
  const droppedLines: { account_id: string; risk_id: RiskId }[] = [];
  const currentSets = new Map(
    current.accounts.flatMap((c) => c.resource_sets.map((set) => [set.key, c.account_id])),
  );

  const usableNow = (id: string): IssuanceAccount | undefined =>
    context.accounts.find((c) => c.id === id && c.status !== 'revoked');
  // The accounts that no longer serve the mission now (disconnected, gone, an access
  // withdrawn): a restore never judges them, so it leaves them as they stand, lost, whatever
  // the version says. Only "Remove from mission" takes one out; nothing brings one back.
  const carried = current.accounts.filter((c) => !usableNow(c.account_id));
  const kept: { account: MissionVersionAccount; ctx: IssuanceAccount }[] = [];
  for (const account of config.accounts) {
    const ctx = usableNow(account.account_id);
    if (!ctx) {
      // Still on the mission, lost: carried as it stands below, not dropped from it.
      if (!carried.some((c) => c.account_id === account.account_id)) {
        droppedAccounts.push(account.account_id);
      }
      continue;
    }
    kept.push({ account, ctx });
  }

  const lines: DraftLine[] = [];
  const shapes = kept.map(({ account, ctx }, accountIndex) => {
    const usable = new Set(ctx.resources.filter((r) => !r.stale && !r.self).map((r) => r.id));
    const authority = new Set(ctx.authority);
    const sets = account.resource_sets.map((set, setIndex) => {
      const ids = set.resource_ids.filter((id) => {
        if (usable.has(id)) return true;
        droppedResources.push({ account_id: account.account_id, resource_id: id });
        return false;
      });
      for (const line of config.policy.filter((p) => p.resource_set_id === set.id)) {
        if (authority.has(line.risk_id)) lines.push({ accountIndex, setIndex, line });
        else droppedLines.push({ account_id: account.account_id, risk_id: line.risk_id });
      }
      return { set, ids };
    });
    return { account, sets };
  });

  const draftOf = (remaining: readonly DraftLine[]): MissionDraft => ({
    name: config.name,
    period: current.period,
    expires_at: expiryOf(config, current, context.now),
    accounts: shapes
      .map(({ account, sets }, accountIndex): DraftAccount => {
        const drafted = sets.map(({ set, ids }, setIndex): DraftResourceSet & { id?: string } => {
          const policy = remaining
            .filter((l) => l.accountIndex === accountIndex && l.setIndex === setIndex)
            .map(({ line }) => ({
              risk_id: line.risk_id,
              quota: line.quota,
              rate_limit: { ...line.rate_limit },
              gate: line.gate,
            }));
          const legacyWhole = set.mixed_env && set.future;
          return {
            ...(currentSets.get(set.id) === account.account_id ? { id: set.id } : {}),
            resources: legacyWhole
              ? { scope: 'account' }
              : { scope: 'selected', resource_ids: [...ids] },
            ...(set.mixed_env ? {} : { future: set.future }),
            ...(!set.mixed_env && ids.length === 0 ? { env: set.env } : {}),
            everything_i_hold: false,
            policy,
            ...(Object.keys(set.trust_levels).length > 0
              ? { trust_levels: { ...set.trust_levels } }
              : {}),
          };
        });
        const [only] = drafted;
        // One set: drafted flat, so that it keeps the mission's one set (and its counters).
        if (drafted.length === 1 && only) {
          const { id: _id, ...fields } = only;
          return { account_id: account.account_id, ...fields };
        }
        return { account_id: account.account_id, resource_sets: drafted };
      })
      .concat(carried.map(draftAccountOf)),
  });

  let remaining = lines;
  let draft = draftOf(remaining);
  let judgement = judgeEdit(context, current, draft);
  for (let pass = 0; pass < MAX_PASSES && !judgement.ok; pass += 1) {
    const refused = refusedLines(judgement.issues, remaining);
    if (refused.size === 0) break;
    for (const l of remaining) {
      if (refused.has(l)) {
        droppedLines.push({
          account_id: kept[l.accountIndex]?.account.account_id ?? '',
          risk_id: l.line.risk_id,
        });
      }
    }
    remaining = remaining.filter((l) => !refused.has(l));
    draft = draftOf(remaining);
    judgement = judgeEdit(context, current, draft);
  }

  return {
    draft,
    judgement,
    dropped: {
      accounts: droppedAccounts,
      resources: droppedResources,
      permissions: droppedLines,
      expiry_kept: expiryOf(config, current, context.now) !== config.expires_at,
    },
  };
}

/** The version's end, unless it has passed: then the mission's current one. */
function expiryOf(
  config: MissionVersionConfig,
  current: MissionSnapshot,
  now: Date,
): string | null {
  if (config.expires_at === null) return null;
  return Date.parse(config.expires_at) > now.getTime() ? config.expires_at : current.expires_at;
}

/** The draft lines an issue refuses for their risk: of its account (and set), when it names them. */
function refusedLines(
  issues: readonly PreviewIssue[],
  lines: readonly DraftLine[],
): Set<DraftLine> {
  const refused = new Set<DraftLine>();
  for (const issue of issues) {
    if (!LINE_DROPPING.has(issue.code) || !issue.risk_ids) continue;
    const risks = new Set(issue.risk_ids);
    for (const l of lines) {
      if (!risks.has(l.line.risk_id)) continue;
      if (issue.account_index !== undefined && issue.account_index !== l.accountIndex) continue;
      if (issue.resource_set_index !== undefined && issue.resource_set_index !== l.setIndex) {
        continue;
      }
      refused.add(l);
    }
  }
  return refused;
}
