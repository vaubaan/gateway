/**
 * Shared rig of the audit suites: the real composition root on the `:memory:`
 * store (shipped plugins, seeded connections), a mission issued through the
 * real `MissionService`, and calls seeded the way the execution door
 * produces them: `SessionService.recordCall` for the
 * session, counters and events, then the store's audit writer for the entry —
 * the two halves `CallPipeline` runs for every call.
 */
import { fingerprintArguments, type CallAuditEntry } from '@vaubaan/gateway-core';
import type { RiskId, TokenAttribution } from '@vaubaan/shared';

import {
  budgetMissionOf,
  type RecordCallResult,
  type SessionService,
} from '../../../src/server/budget';
import type { GatewayRoot } from '../../../src/server/compose/root';
import type { MissionDraft } from '../../../src/server/missions';
import type { MissionRecord, UserRecord } from '../../../src/server/store/types';
import { buildTestRoot, seedInstance, type SeededInstance } from '../missions/support';

export const OPERATOR_EMAIL = 'ops@example.com';
export const READ = 'github.read-code';
export const PR = 'github.create-pr';
export const MERGE = 'github.merge-protected';
export const DAY_SECONDS = 86_400;

/** Never stored anywhere readable: the suites look for it in what the pages receive. */
export const ARGUMENT_MARKER = 'RAW-ARGUMENT-MARKER-7f3a';

export interface AuditRig {
  readonly root: GatewayRoot;
  readonly seeded: SeededInstance;
  readonly budget: SessionService;
}

export interface OperatorRig extends AuditRig {
  readonly operator: UserRecord;
}

/** The rig over a root that already exists (the browser tests' ephemeral instance). */
export function auditRigOn(root: GatewayRoot, seeded: SeededInstance): AuditRig {
  // The service the execution door decides with, not a second one over the same store.
  return { root, seeded, budget: root.budget };
}

export async function openAuditRig(): Promise<OperatorRig> {
  const root = await buildTestRoot({ env: { VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL } });
  const seeded = await seedInstance(root);
  const operator = await root.store.users.upsertFromIdp({
    issuer: 'http://idp.test',
    subject: 'idp|ops',
    email: OPERATOR_EMAIL,
    displayName: 'Ops',
  });
  return { ...auditRigOn(root, seeded), operator };
}

/** A daily GitHub mission of Ada: reads (5), pull requests (2), protected merges under approval. */
export function githubDraft(rig: AuditRig, overrides: Partial<MissionDraft> = {}): MissionDraft {
  return {
    name: 'Ship the billing page',
    connections: [
      {
        connection_id: rig.seeded.github.connection.id,
        policy: [
          { risk_id: READ, quota: 5, rate_limit: { max: 50, window_seconds: 60 } },
          { risk_id: PR, quota: 2, rate_limit: { max: 50, window_seconds: 60 } },
          {
            risk_id: MERGE,
            quota: 2,
            rate_limit: { max: 50, window_seconds: 60 },
            gate: 'approval',
          },
        ],
      },
    ],
    period: { kind: 'recurring', length_seconds: DAY_SECONDS },
    expires_at: null,
    ...overrides,
  };
}

export async function issueMission(
  rig: AuditRig,
  user: UserRecord = rig.seeded.ada,
  draft: MissionDraft = githubDraft(rig),
): Promise<MissionRecord> {
  const result = await rig.root.missions.service.issue(user, draft);
  if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
  return result.mission;
}

export interface SeedCall {
  readonly tool?: string;
  readonly risks?: readonly RiskId[];
  readonly args?: Record<string, unknown>;
  readonly agentLabel?: string | null;
  /**
   * Whose token the call presented. Defaults to a member token of the mission's
   * creator, as every mission is born with; `null` writes an entry and an event
   * with no holder, as before tokens had one.
   */
  readonly token?: TokenAttribution | null;
  readonly now?: Date;
  /** Defaults to the mission's first connection. */
  readonly connectionId?: string | null;
  readonly resourceRef?: string | null;
  readonly upstreamError?: string | null;
}

export interface SeededCall {
  readonly result: RecordCallResult;
  readonly entry: CallAuditEntry;
}

/** One call through the budget, then its audit entry, as `CallPipeline` writes it. */
export async function seedCall(
  rig: AuditRig,
  mission: MissionRecord,
  call: SeedCall = {},
): Promise<SeededCall> {
  const now = call.now ?? new Date();
  const tool = call.tool ?? 'github__get_file';
  const risks = call.risks ?? [READ];
  const args = call.args ?? { path: 'README.md', note: ARGUMENT_MARKER };
  const agentLabel = call.agentLabel ?? null;
  const token =
    call.token === undefined
      ? { token_id: 'seeded-token', token_kind: 'member' as const, holder: mission.creatorUserId }
      : call.token;
  const result = await rig.budget.recordCall({
    mission: budgetMissionOf(mission),
    tool,
    args,
    risks_touched: risks,
    agent_label: agentLabel,
    token,
    now,
  });
  const allowed = result.outcome === 'allowed';
  const entry: CallAuditEntry = {
    kind: 'call',
    ts: now.toISOString(),
    mission_id: mission.id,
    token_id: token?.token_id ?? null,
    token_kind: token?.token_kind ?? null,
    token_holder: token?.holder ?? null,
    session_id: result.session_id,
    connection_id:
      call.connectionId === undefined
        ? (mission.connections[0]?.connectionId ?? null)
        : call.connectionId,
    resource_ref: call.resourceRef ?? 'acme/app',
    tool,
    arguments_hash: fingerprintArguments(args),
    slices_executed: [],
    risks_touched: risks,
    accepted_risks_snapshot: mission.policy.map((p) => p.riskId),
    decision: allowed ? 'allowed' : 'refused',
    refusal_code: allowed ? null : result.refusal.code,
    refusal_reason: allowed ? null : result.refusal.hint,
    approval_id: allowed ? (result.approval_ids[0] ?? null) : null,
    remaining_budget: allowed ? result.remaining : null,
    agent_label: agentLabel,
    upstream_latency_ms: allowed ? 12 : null,
    upstream_error: allowed ? (call.upstreamError ?? null) : null,
    client_ip: '203.0.113.7',
    client_user_agent: 'claude-code/test',
  };
  await rig.root.store.auditWriter.write(entry);
  return { result, entry };
}

export const userViewer = (user: UserRecord, isOperator = false, groupIds: string[] = []) =>
  ({
    kind: 'user',
    user,
    groups: groupIds.map((id) => ({ id })),
    isOperator,
  }) as const;

export const NO_FILTER = {
  missionId: null,
  user: null,
  connectionId: null,
  tool: null,
  decision: null,
  agentLabel: null,
  tokenHolder: null,
  kind: null,
  since: null,
  until: null,
} as const;

export interface SeededDay {
  readonly mission_id: string;
  readonly claim_id: string;
  readonly approval_id: string;
}

/**
 * A mission of Ada with a day of work on it: reads by two labelled agents,
 * the pull-request quota spent and a third one refused (a claim is open), a
 * protected merge awaiting approval. For the browser tests.
 */
export async function seedDayOfWork(rig: AuditRig): Promise<SeededDay> {
  const mission = await issueMission(
    rig,
    rig.seeded.ada,
    githubDraft(rig, { name: 'A day of work' }),
  );
  await seedCall(rig, mission, { agentLabel: 'planner' });
  await seedCall(rig, mission, { agentLabel: 'coder' });
  const pr = { tool: 'github__create_pull_request', risks: [PR], agentLabel: 'coder' } as const;
  await seedCall(rig, mission, pr);
  await seedCall(rig, mission, pr);
  const claim = await seedCall(rig, mission, pr);
  const approval = await seedCall(rig, mission, {
    tool: 'github__merge_pull_request',
    risks: [MERGE],
    args: { pull_number: 12, note: ARGUMENT_MARKER },
    agentLabel: 'coder',
  });
  if (claim.result.outcome !== 'refused' || approval.result.outcome !== 'refused') {
    throw new Error('expected the third pull request and the merge to be refused');
  }
  if (!claim.result.request_id || !approval.result.request_id) {
    throw new Error('expected both refusals to open a request');
  }
  return {
    mission_id: mission.id,
    claim_id: claim.result.request_id,
    approval_id: approval.result.request_id,
  };
}
