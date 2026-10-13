/**
 * The pipeline's `BudgetStage` over the `SessionService`.
 *
 * `@vaubaan/gateway-core`'s `CallPipeline` calls `budget.decide(ctx, call,
 * { risks_touched, now })` after the risk stage allowed the call and expects a
 * `BudgetDecision`. This adapter maps the cached `MissionContext` to the budget's
 * `BudgetMission` and the service's result back to the pipeline's shape.
 *
 * The policy used is the context's own (`ctx.policy`): it is the enumeration the risk
 * stage just checked `risks_touched` against, so the two stages of one call always
 * agree. A recurring period is complete in the context; a one-off period has no
 * anchor in the shared `Period`, so the mission row is read for the anchor the store
 * recorded at issuance (the counters of a one-off mission are keyed by it).
 */

import type { BudgetDecision, BudgetStage, MissionContext } from '@vaubaan/gateway-core';
import type { MissionsRepo } from '../store/index.ts';
import { BudgetInvariantError } from './errors.ts';
import type { BudgetMission } from './mapping.ts';
import { periodSpecOf, type PeriodSpec } from './period.ts';
import type { SessionService } from './session-service.ts';

export interface BudgetStageDeps {
  readonly service: SessionService;
  readonly missions: Pick<MissionsRepo, 'getById'>;
}

export function createBudgetStage(deps: BudgetStageDeps): BudgetStage {
  async function periodOf(ctx: MissionContext): Promise<PeriodSpec> {
    const { period } = ctx.mission;
    if (period.kind === 'recurring') return periodSpecOf(period, period.anchor_at);
    const record = await deps.missions.getById(ctx.mission.id);
    if (!record) throw new BudgetInvariantError(`mission ${ctx.mission.id} vanished mid-call`);
    return periodSpecOf(period, record.periodAnchor);
  }

  return {
    async decide(ctx, call, input): Promise<BudgetDecision> {
      const mission: BudgetMission = {
        id: ctx.mission.id,
        status: ctx.mission.status,
        expires_at: ctx.mission.expires_at,
        period: await periodOf(ctx),
        policy: ctx.policy,
      };
      const result = await deps.service.recordCall({
        mission,
        tool: call.tool,
        args: call.args,
        risks_touched: input.risks_touched,
        agent_label: call.agent_label,
        now: input.now,
      });
      if (result.outcome === 'refused') return { outcome: 'refused', refusal: result.refusal };
      return {
        outcome: 'allowed',
        session_id: result.session_id,
        remaining: result.remaining,
        // The audit entry carries one approval id; a call touching several gated
        // risks consumed one per risk, all listed on the session event.
        approval_id: result.approval_ids[0] ?? null,
      };
    },
  };
}
