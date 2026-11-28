/**
 * The creator changes an issued mission's permissions in place (spec §3.2, §3.5): the
 * gate of an accepted risk, the limits of accepted risks, and lines added or removed —
 * directly or in answer to a permission request. The mission service delegates these
 * acts here; the whole edit is in `mission-edits.ts`.
 */
import {
  isGate,
  lineKeyOf,
  parseRiskId,
  policyLineKey,
  type MissionPolicyEntry,
  type RiskId,
} from '@vaubaan/shared';

import type { Subject } from '../authority';
import { budgetMissionOf, policyEntryRecordOf } from '../budget';
import { toIso } from '../store/clock';
import type { MissionRecord, RequestLine } from '../store/types';
import type { PreviewIssue, Row } from '../../lib/missions/model';
import { checkPolicyLines } from '../../lib/missions/preview';
import { gateEditBlockedBy } from './gate-edit';
import type { MissionLookups } from './mission-lookups';
import { permissionEditSchema, policyKey } from './permission-edit';
import type {
  MissionServiceDeps,
  SetGateResult,
  LimitEdit,
  LimitChangeView,
  SetLimitsResult,
} from './mission-views';

export class MissionPolicyChanges {
  constructor(
    private readonly deps: MissionServiceDeps,
    private readonly lookups: MissionLookups,
  ) {}

  /**
   * The creator edits the gate of one accepted risk after issuance (spec §3.5 "at
   * issuance, or later"): `auto` ⇄ `approval`. Only the gate moves — the accepted
   * risks, quotas and rate limits are the mission's as issued, and a gate is not part
   * of what a share restricts, so no authority is re-checked. The edit applies to the
   * next call, ends an opening "for the rest of the period" granted earlier on that
   * risk, and leaves the open requests where they are.
   */
  async setGate(
    user: Subject,
    missionId: string,
    riskId: RiskId,
    gate: string,
    /** The set of the line; absent when exactly one set of the mission accepts the risk. */
    resourceSetId?: string,
  ): Promise<SetGateResult> {
    const mission = await this.lookups.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    if (!isGate(gate)) return { ok: false, reason: 'invalid-gate' };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false, reason: 'inactive', state: blocked };
    // "Ask me again" on a risk that is gated but open for the period must end the
    // opening: the stored gate would not move, so the store is told what was found.
    // The opening is looked for in the period that runs NOW, whether or not the mission
    // serves at this instant: an expired mission whose expiry is then extended in the
    // same period would otherwise come back with the opening the creator just closed.
    //
    // single-process only: the read and the write are two store calls, so an opening
    // granted between them is missed. Not reachable while every store call is
    // synchronous in one process; with a second process, decide inside
    // `MissionsRepo.setGate`'s transaction (it owns the mission log's events).
    const line = lineOfRisk(mission, riskId, resourceSetId);
    if (!line) return { ok: false, reason: 'risk-not-in-policy' };
    const openNow =
      gate === 'approval' &&
      (await this.lookups.openGatesIn(mission, this.lookups.periodNow(mission))).has(
        policyLineKey(line.resourceSetId, riskId),
      );
    const changed = await this.deps.store.missions.setGate(mission.id, line, gate, user.id, {
      closeOpening: openNow,
    });
    if (!changed) return { ok: false, reason: 'risk-not-in-policy' };
    const { previous, openingClosed } = changed;
    if (previous !== gate || openingClosed) {
      await this.deps.store.auditWriter.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: user.id,
        act: 'gate-changed',
        object: { type: 'mission', id: mission.id },
        before: {
          risk_id: riskId,
          resource_set_id: line.resourceSetId,
          gate: previous,
          ...(openingClosed ? { open_for_period: true } : {}),
        },
        after: {
          risk_id: riskId,
          resource_set_id: line.resourceSetId,
          gate,
          ...(openingClosed ? { open_for_period: false } : {}),
        },
      });
      this.deps.logger.info('mission gate changed', {
        mission_id: mission.id,
        risk_id: riskId,
        gate,
        opening_closed: openingClosed,
      });
    }
    return {
      ok: true,
      mission: changed.mission,
      risk_id: riskId,
      gate,
      previous,
      opening_closed: openingClosed,
    };
  }

  /**
   * The creator changes the limits of accepted risks after issuance (spec §3.2): per
   * risk already in the mission, its quota per period and its calls per rate window, up
   * or down. Never a risk added or removed, never the period nor the rate window, never
   * the gate (that is `setGate`). Creator only, like every mutation of a mission; there
   * is no delegated variant: the management door is not handed this method.
   *
   * A value that moves is judged by issuance's own check of a policy line
   * (`checkPolicyLines`): inside the creator's authority on the account NOW, a whole
   * number of at least one, a rate under the catalog's ceiling. Whatever caps a creation
   * caps the change; a value that does not move is not judged again.
   *
   * The change applies to the current period at once: what was used stays used, and a
   * quota lowered under it leaves the risk exhausted until the reset. The budget reads
   * the stored limits inside its decision transaction (`DecideContext.limits`), so no
   * call decided after the write commits passes above the new limit. One
   * `limits-changed` audit entry carries every risk that moved, before and after.
   *
   * Between the authority check and the write, the creator's authority may go: the
   * mission then reads `orphaned` and serves nothing, as an issuance racing the same
   * revocation would.
   */
  async setLimits(
    user: Subject,
    missionId: string,
    edits: readonly LimitEdit[],
  ): Promise<SetLimitsResult> {
    const mission = await this.lookups.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false, reason: 'inactive', state: blocked };
    if (edits.length === 0) {
      return { ok: false, reason: 'invalid-limits', problem: 'No permission is listed.' };
    }
    const ids = edits.map((edit) => edit.risk_id);
    const placed = edits.map((edit) => lineOfRisk(mission, edit.risk_id, edit.resource_set_id));
    const outside = edits.filter((_, i) => placed[i] === null).map((edit) => edit.risk_id);
    if (outside.length > 0) return { ok: false, reason: 'risk-not-in-policy', risk_ids: outside };
    const keys = placed.map((line) =>
      line ? policyLineKey(line.resourceSetId, line.riskId) : null,
    );
    const twice = [
      ...new Set(edits.filter((_, i) => keys.indexOf(keys[i] ?? null) !== i).map((e) => e.risk_id)),
    ];
    if (twice.length > 0) {
      return {
        ok: false,
        reason: 'invalid-limits',
        problem: `Listed more than once: ${twice.join(', ')}.`,
      };
    }
    const stored = new Map(
      mission.policy.map(
        (entry) => [policyLineKey(entry.resourceSetId, entry.riskId), entry] as const,
      ),
    );

    // The lines that move, as issuance would read them: same gate, same window.
    const moving: MissionPolicyEntry[] = [];
    edits.forEach((edit, i) => {
      const key = keys[i];
      const entry = key ? stored.get(key) : undefined;
      if (!entry || (entry.quota === edit.quota && entry.rateLimit === edit.rate_limit_max)) {
        return;
      }
      moving.push({
        resource_set_id: entry.resourceSetId,
        risk_id: edit.risk_id,
        quota: edit.quota,
        rate_limit: { max: edit.rate_limit_max, window_seconds: entry.rateWindowSeconds },
        gate: entry.gate,
      });
    });
    const issues = await this.limitIssues(user, mission, moving);
    if (issues.length > 0) return { ok: false, reason: 'refused', issues };

    const written = await this.deps.store.missions.setLimits(
      mission.id,
      edits.map((edit, i) => ({
        ...(placed[i] ? { resourceSetId: placed[i].resourceSetId } : {}),
        riskId: edit.risk_id,
        quota: edit.quota,
        rateLimit: edit.rate_limit_max,
      })),
      user.id,
    );
    if (!written) return { ok: false, reason: 'risk-not-in-policy', risk_ids: ids };
    const changed: LimitChangeView[] = written.changes
      .filter((change) => change.changed)
      .map((change) => ({
        risk_id: change.riskId,
        resource_set_id: change.resourceSetId,
        before: {
          quota: change.before.quota,
          rate_limit: { max: change.before.rateLimit, window_seconds: change.rateWindowSeconds },
        },
        after: {
          quota: change.after.quota,
          rate_limit: { max: change.after.rateLimit, window_seconds: change.rateWindowSeconds },
        },
      }));
    if (changed.length > 0) {
      await this.deps.store.auditWriter.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: user.id,
        act: 'limits-changed',
        object: { type: 'mission', id: mission.id },
        before: { limits: changed.map((c) => ({ risk_id: c.risk_id, ...c.before })) },
        after: { limits: changed.map((c) => ({ risk_id: c.risk_id, ...c.after })) },
      });
      this.deps.logger.info('mission limits changed', {
        mission_id: mission.id,
        risks: changed.length,
      });
    }
    return { ok: true, mission: written.mission, changed };
  }

  async permissionOptions(user: Subject, missionId: string) {
    const mission = await this.lookups.ownMission(user, missionId);
    if (!mission || gateEditBlockedBy(mission)) return null;
    const reached = await this.lookups.detailAccounts(mission);
    const candidates: {
      risk_id: string;
      /** The set the line would join (risk model §4.7). */
      resource_set_id: string;
      /** "Resource set 2" when the account has several; `null` otherwise. */
      resource_set_label: string | null;
      label: string;
      row: Row;
      reason: string;
      available: boolean;
      ceiling: number | null;
    }[] = [];
    for (const selected of mission.accounts) {
      const account = await this.deps.store.accounts.getById(selected.accountId);
      // A revoked account serves the mission no more: nothing is added on it.
      if (!account || account.status === 'revoked') continue;
      const context = await this.lookups.issuanceAccount(user, account);
      if (!context) continue;
      const sets = reached.find((r) => r.id === account.id)?.resource_sets ?? [];
      for (const set of sets) {
        for (const risk of context.risks) {
          const line: MissionPolicyEntry = {
            risk_id: risk.risk_id,
            quota: 1,
            rate_limit: { max: 1, window_seconds: 60 },
            gate: 'approval',
          };
          const issues = checkPolicyLines(context, set.resources, [line], 0).issues;
          candidates.push({
            risk_id: risk.risk_id,
            resource_set_id: set.id,
            resource_set_label: sets.length > 1 ? `Resource set ${set.position}` : null,
            label: risk.label,
            row: risk.row,
            reason: issues.map((i) => i.message).join(' '),
            available: issues.length === 0,
            ceiling: risk.rate_ceiling_per_minute,
          });
        }
      }
    }
    return {
      missionId: mission.id,
      missionName: mission.name,
      policy: budgetMissionOf(mission).policy,
      periodSeconds: mission.periodSeconds,
      candidates,
    };
  }

  /** Shared by a direct edit and the creator's answer to a permission request. */
  async changePermissions(user: Subject, missionId: string, raw: unknown) {
    const mission = await this.lookups.ownMission(user, missionId);
    if (!mission) return { ok: false as const, reason: 'not-found' };
    const parsed = permissionEditSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, reason: 'invalid-edit' };
    const edit = parsed.data;
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false as const, reason: 'inactive', state: blocked };
    const before = budgetMissionOf(mission).policy;
    const asked = edit.request_id
      ? ((await this.deps.store.requests.getById(edit.request_id))?.lines ?? [])
      : [];
    const firstSets = new Map<string, string>();
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      const first = c.resourceSets[0];
      if (account && first) firstSets.set(account.service, first.id);
    }
    const expected = placeLines(mission, edit.expected_policy, asked, firstSets);
    const policy = placeLines(mission, edit.policy, asked, firstSets);
    if (!expected || !policy) return { ok: false as const, reason: 'invalid-edit' };
    if (policyKey(before) !== policyKey(expected))
      return { ok: false as const, reason: 'conflict' };
    if (new Set(policy.map(lineKeyOf)).size !== policy.length)
      return { ok: false as const, reason: 'invalid-edit' };
    // Existing lines use the dedicated limits and gate controls; this edit adds/removes.
    const previous = new Map(before.map((p) => [lineKeyOf(p), p]));
    if (
      policy.some((p) => {
        const was = previous.get(lineKeyOf(p));
        return was !== undefined && policyKey([p]) !== policyKey([was]);
      })
    ) {
      return { ok: false as const, reason: 'invalid-edit' };
    }
    const additions = policy.filter((p) => !previous.has(lineKeyOf(p)));
    const issues = await this.limitIssues(user, mission, additions);
    if (issues.length) return { ok: false as const, reason: 'refused', issues };
    const asStored = (lines: readonly MissionPolicyEntry[]) =>
      lines.map((p) => policyEntryRecordOf({ ...p, resource_set_id: p.resource_set_id ?? '' }));
    if (policyKey(before) === policyKey(policy) && !edit.request_id)
      return { ok: true as const, mission };
    const written = await this.deps.store.missions.changePermissions(
      mission.id,
      asStored(policy),
      asStored(before),
      user.id,
      edit.request_id,
    );
    if (!written) return { ok: false as const, reason: 'conflict' };
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'permissions-changed',
      object: { type: 'mission', id: mission.id },
      before: { policy: before },
      after: { policy, request_id: edit.request_id ?? null },
    });
    return { ok: true as const, mission: written };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Edit after issuance (ADR mission-editable-after-issuance)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Why issuance would refuse these lines on the mission's accounts now: each line
   * checked against the creator's authority on the account of its service, on the
   * resources the mission reaches there. Empty when every line passes.
   */
  private async limitIssues(
    user: Subject,
    mission: MissionRecord,
    lines: readonly MissionPolicyEntry[],
  ): Promise<PreviewIssue[]> {
    if (lines.length === 0) return [];
    const issues: PreviewIssue[] = [];
    const judged = new Set<RiskId>();
    const reached = await this.lookups.detailAccounts(mission);
    for (const [index, c] of mission.accounts.entries()) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account) continue;
      const sets = reached.find((r) => r.id === account.id)?.resource_sets ?? [];
      // A line placed in a set belongs to that set's account; an unplaced one to
      // every account of its service (several may be in the mission).
      const own = lines.filter(
        (line) =>
          parseRiskId(line.risk_id)?.service === account.service &&
          (line.resource_set_id === undefined ||
            sets.some((set) => set.id === line.resource_set_id)),
      );
      if (own.length === 0) continue;
      for (const line of own) judged.add(line.risk_id);
      // A revoked account's part of the mission is lost for good: nothing widens on it.
      const context =
        account.status === 'revoked' ? null : await this.lookups.issuanceAccount(user, account);
      if (!context) {
        issues.push({
          code: 'exceeds-authority',
          message: `Outside your authority on "${account.displayName}": ${own
            .map((line) => line.risk_id)
            .join(', ')}.`,
          risk_ids: own.map((line) => line.risk_id),
          account_index: index,
          account_id: account.id,
        });
        continue;
      }
      for (const set of sets) {
        const ofSet = own.filter((line) => (line.resource_set_id ?? set.id) === set.id);
        if (ofSet.length === 0) continue;
        issues.push(...checkPolicyLines(context, set.resources, ofSet, index).issues);
      }
    }
    const unplaced = lines.filter((line) => !judged.has(line.risk_id)).map((l) => l.risk_id);
    if (unplaced.length > 0) {
      // A risk of a service none of the mission's accounts is for: nothing grounds it.
      issues.push({
        code: 'exceeds-authority',
        message: `No account of this mission carries ${unplaced.join(', ')}.`,
        risk_ids: unplaced,
      });
    }
    return issues;
  }
}

/**
 * The line of a risk in the mission: in `resourceSetId` when given, else the one set
 * that accepts the risk. `null` when absent, or when the risk alone names several lines.
 */
function lineOfRisk(
  mission: Pick<MissionRecord, 'policy'>,
  riskId: RiskId,
  resourceSetId: string | undefined,
): RequestLine | null {
  const lines = mission.policy.filter(
    (entry) =>
      entry.riskId === riskId &&
      (resourceSetId === undefined || entry.resourceSetId === resourceSetId),
  );
  const [only] = lines;
  return lines.length === 1 && only ? { resourceSetId: only.resourceSetId, riskId } : null;
}

/**
 * The lines of a permission edit, each in its set: the one it names, else the set of the
 * mission's line of that risk (when only one set accepts it), else the set the answered
 * request names for it, else the first set of the account of its service. `null` when
 * a line cannot be placed (several sets accept the risk, or no account is for it).
 */
function placeLines(
  mission: Pick<MissionRecord, 'policy'>,
  lines: readonly MissionPolicyEntry[],
  asked: readonly RequestLine[],
  /** The first set of the account of each service of the mission. */
  firstSets: ReadonlyMap<string, string>,
): MissionPolicyEntry[] | null {
  const placed: MissionPolicyEntry[] = [];
  for (const line of lines) {
    if (line.resource_set_id !== undefined) {
      placed.push(line);
      continue;
    }
    const held = mission.policy.filter((entry) => entry.riskId === line.risk_id);
    const [only] = held;
    if (held.length > 1) return null;
    const setId =
      only?.resourceSetId ??
      asked.find((a) => a.riskId === line.risk_id)?.resourceSetId ??
      firstSets.get(parseRiskId(line.risk_id)?.service ?? '');
    if (setId === undefined) return null;
    placed.push({ ...line, resource_set_id: setId });
  }
  return placed;
}
