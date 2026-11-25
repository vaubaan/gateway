/**
 * "Approve an action" through the real execution door (spec §7.7, §3.5, §4.1
 * `approval-required`; §10 "integration: approval and replay"): the real GitHub
 * plugin, its Read, Propose and Administer macro-actions at Trusting, a mocked
 * upstream.
 *
 * Administer at Trusting gates `github.workflow-write-via-file` (row 3). A file write under
 * `.github/workflows/` on a feature branch touches that risk and the ungated
 * `github.feature-branch-write`: a multi-risk call with one gated risk. Over JSON-RPC
 * on `/mcp`: refusal → the creator grants → the identical replay passes and reaches
 * the service → the second identical replay is refused.
 */
import { githubPlugin } from '@vaubaan/plugin-github';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { budgetMissionOf } from '../../../src/server/budget';
import { serializeSecret } from '../../../src/server/accounts';
import {
  executionInstance,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type IssuedMission,
  type RpcBody,
} from '../../support/execution/testing';

const PAT = 'github_pat_11AAAAAAA0TEST_0123456789abcdefghijklmnopqrstuvwxyz';
const GATED = 'github.workflow-write-via-file';
const UNGATED = 'github.feature-branch-write';
const TOOL = 'github__create_or_update_file';
/** Never stored in clear, never in the audit, never in a log. */
const WORKFLOW_BODY = 'name: ci\non: push\n# WORKFLOW-CONTENT-MARKER-5d2e\n';
const ARGS = {
  owner: 'acme',
  repo: 'app',
  branch: 'feature/ci',
  path: '.github/workflows/ci.yml',
  message: 'ci: add the pipeline',
  content: WORKFLOW_BODY,
};

interface Rig extends ExecutionInstance {
  readonly upstream: MockFetch;
  readonly logs: string[];
  readonly mission: IssuedMission;
}

async function openRig(): Promise<Rig> {
  const upstream = mockFetch([
    {
      method: 'PUT',
      url: /^https:\/\/api\.github\.com\/repos\/acme\/app\/contents\//,
      status: 201,
      body: { content: { path: ARGS.path }, commit: { sha: 'c0ffee' } },
    },
  ]);
  const logs: string[] = [];
  const instance = await executionInstance({
    plugins: [githubPlugin],
    env: {
      VAUBAAN_LOG_LEVEL: 'debug',
    },
    deps: { serviceFetch: upstream, logWrite: (_level, text) => logs.push(text) },
  });
  const { store, missions } = instance.root;
  const github = await store.accounts.create({
    service: 'github',
    owner: { kind: 'user', id: instance.ada.id },
    displayName: 'acme-org',
    credential: serializeSecret({ kind: 'api-key', fields: { token: PAT }, metadata: {} }),
  });
  await store.accounts.syncDiscoveredResources(github.id, [
    { ref: 'acme/app', displayName: 'acme/app', env: null },
  ]);
  const issued = await missions.service.issue(instance.ada, {
    name: 'Develop acme/app',
    // The macro-actions as the plugin ships them, at a trust level: nothing adjusted.
    accounts: [
      {
        account_id: github.id,
        trust_levels: { read: 'trusting', propose: 'trusting', administer: 'trusting' },
      },
    ],
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
  });
  if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
  return {
    ...instance,
    upstream,
    logs,
    mission: { mission: issued.mission, token: issued.token.secret, prefix: issued.token.prefix },
  };
}

describe('approve an action through the execution door (GitHub macro-actions at Trusting)', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await openRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  const write = (args: Record<string, unknown> = ARGS): Promise<RpcBody> =>
    rig.call(rig.mission, TOOL, args);
  const writesUpstream = () => rig.upstream.calls.filter((c) => c.method === 'PUT');

  function refusalOf(body: RpcBody): Record<string, unknown> {
    if (!body.error?.data) throw new Error(`expected a refusal, got ${JSON.stringify(body)}`);
    return body.error.data;
  }

  function requestIdOf(refusal: Record<string, unknown>): string {
    const url = String(refusal.approval_url);
    expect(url).toMatch(new RegExp(`^${TEST_PUBLIC_URL}/r/[0-9a-f-]{36}$`));
    return url.slice(url.lastIndexOf('/') + 1);
  }

  /** The quota the trust level wrote: the macro-action's base budget ×3 at Trusting. */
  const quota = (riskId: string): number => {
    const entry = rig.mission.mission.policy.find((e) => e.riskId === riskId);
    if (!entry) throw new Error(`${riskId} is not in the mission`);
    return entry.quota;
  };

  const counters = async () => {
    const usage = await rig.root.budget.usageOf(budgetMissionOf(rig.mission.mission), new Date());
    // One set on the account: the counters read by risk.
    return Object.fromEntries(
      [...usage.consumed].map(([line, n]) => [line.slice(line.indexOf('::') + 2), n]),
    );
  };

  it('Trusting gates the workflow write, and nothing else on this call', () => {
    const gate = (riskId: string) =>
      rig.mission.mission.policy.find((entry) => entry.riskId === riskId)?.gate;
    expect(gate(GATED)).toBe('approval');
    expect(gate(UNGATED)).toBe('auto');
  });

  it('refusal → grant → the identical replay passes → the second identical replay is refused', async () => {
    // ── The refusal: the whole call, nothing forwarded ──────────────────────
    const refusal = refusalOf(await write());
    expect(refusal).toMatchObject({
      code: 'approval-required',
      risk_id: GATED,
      approval_valid_seconds: rig.root.config.approvals.expirySeconds,
    });
    expect(refusal.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(String(refusal.expires_at))).toBeGreaterThan(Date.now());
    expect(String(refusal.hint)).toContain(String(refusal.approval_url));
    expect(String(refusal.hint)).toMatch(/exactly the same arguments/);
    expect(JSON.stringify(refusal)).not.toContain('WORKFLOW-CONTENT-MARKER');
    expect(writesUpstream()).toHaveLength(0);
    expect(await counters()).toEqual({});
    const requestId = requestIdOf(refusal);

    // ── What the creator reads: tool, arguments, slices, the risks and their budget ──
    const viewed = await rig.root.requests.service.view(rig.ada, requestId);
    if (viewed.outcome !== 'ok' || viewed.view.kind !== 'approval') {
      throw new Error('expected the view of an approval request');
    }
    const { call } = viewed.view;
    expect(call.tool).toBe(TOOL);
    expect(call.arguments).toEqual(ARGS);
    expect(call.fingerprint).toBe(refusal.fingerprint);
    expect(call.slices).toEqual([
      'github.repo[acme/app].branch[feature/ci].file[.github/workflows/ci.yml].W',
      'github.repo[acme/app].branch[feature/ci].workflow-via-file.W',
    ]);
    expect(call.risks.map((r) => [r.risk_id, r.gate, r.remaining]).sort()).toEqual([
      [UNGATED, 'auto', quota(UNGATED)],
      [GATED, 'approval', quota(GATED)],
    ]);
    expect(viewed.view.request.risk_label).toBe(
      'Modify a GitHub Actions workflow (.github/workflows/*.yml)',
    );

    // ── The grant ───────────────────────────────────────────────────────────
    const decided = await rig.root.requests.service.decide(rig.ada, requestId, {
      resolution: 'grant',
    });
    expect(decided).toMatchObject({ ok: true, request: { state: 'granted' } });

    // ── The identical replay: it passes, reaches the service, counts on both risks ──
    const replay = await write({ ...ARGS });
    expect(replay.error).toBeUndefined();
    expect(replay.result?.isError ?? false).toBe(false);
    expect(writesUpstream()).toHaveLength(1);
    expect(await counters()).toEqual({ [UNGATED]: 1, [GATED]: 1 });

    const entries = await rig.root.store.audit.list({ missionId: rig.mission.mission.id });
    const allowed = entries.find((e) => e.kind === 'call' && e.decision === 'allowed');
    const [approval] = await rig.root.store.approvals.listActive(rig.mission.mission.id);
    expect(approval).toBeUndefined(); // consumed
    expect(allowed).toMatchObject({
      tool: TOOL,
      arguments_hash: refusal.fingerprint,
      approval_id: (await rig.root.store.approvals.getByRequest(requestId))?.id,
      remaining_budget: { [UNGATED]: quota(UNGATED) - 1, [GATED]: quota(GATED) - 1 },
    });

    // ── The second identical replay: the approval was single-use ────────────
    const second = refusalOf(await write());
    expect(second).toMatchObject({ code: 'approval-required', risk_id: GATED });
    expect(requestIdOf(second)).not.toBe(requestId);
    expect(writesUpstream()).toHaveLength(1);
    expect(await counters()).toEqual({ [UNGATED]: 1, [GATED]: 1 });
  });

  it('a call touching two gated risks: one refusal, one request listing both, one grant, one replay', async () => {
    // The creator also gates the branch write: the workflow write now touches two gated risks.
    const gated = await rig.root.missions.service.setGate(
      rig.ada,
      rig.mission.mission.id,
      UNGATED,
      'approval',
    );
    expect(gated).toMatchObject({ ok: true, previous: 'auto' });

    const refusal = refusalOf(await write());
    expect(refusal).toMatchObject({ code: 'approval-required' });
    expect([...(refusal.risk_ids as string[])].sort()).toEqual([UNGATED, GATED].sort());
    expect((refusal.risk_ids as string[])[0]).toBe(refusal.risk_id);
    expect(String(refusal.hint)).toContain('One approval request covers the whole call');
    expect(writesUpstream()).toHaveLength(0);
    const requestId = requestIdOf(refusal);

    // One request in the inbox, both risks on it.
    const inbox = await rig.root.requests.service.inbox(rig.ada);
    expect(inbox.map((r) => r.id)).toEqual([requestId]);
    expect(inbox[0]?.risks.map((r) => r.risk_id).sort()).toEqual([UNGATED, GATED].sort());
    const viewed = await rig.root.requests.service.view(rig.ada, requestId);
    if (viewed.outcome !== 'ok' || viewed.view.kind !== 'approval') {
      throw new Error('expected the view of an approval request');
    }
    expect(viewed.view.gates.map((g) => g.policy)).toEqual(['approval', 'approval']);
    expect(viewed.view.options.find((o) => o.resolution === 'grant')?.consequence).toContain(
      'This one approval covers the 2 gated risks the call touches.',
    );

    // One grant approves the call.
    expect(
      await rig.root.requests.service.decide(rig.ada, requestId, { resolution: 'grant' }),
    ).toMatchObject({ ok: true, request: { state: 'granted' } });
    const replay = await write({ ...ARGS });
    expect(replay.error).toBeUndefined();
    expect(writesUpstream()).toHaveLength(1);
    expect(await counters()).toEqual({ [UNGATED]: 1, [GATED]: 1 });
    expect(await rig.root.store.approvals.listActive(rig.mission.mission.id)).toEqual([]);
    expect(await rig.root.requests.service.inbox(rig.ada)).toEqual([]);

    // Single use, for the call as a whole.
    const second = refusalOf(await write());
    expect(requestIdOf(second)).not.toBe(requestId);
    expect(writesUpstream()).toHaveLength(1);
  });

  it('one byte changed in the arguments asks again; the approval of the other call is left intact', async () => {
    const first = refusalOf(await write());
    await rig.root.requests.service.decide(rig.ada, requestIdOf(first), { resolution: 'grant' });

    const other = refusalOf(await write({ ...ARGS, content: `${WORKFLOW_BODY} ` }));
    expect(other.code).toBe('approval-required');
    expect(other.fingerprint).not.toBe(first.fingerprint);
    expect(writesUpstream()).toHaveLength(0);
    expect(await rig.root.store.approvals.listActive(rig.mission.mission.id)).toHaveLength(1);

    // The same arguments on the tool that deletes the file: another call.
    const deletion = refusalOf(await rig.call(rig.mission, 'github__delete_file', ARGS));
    expect(deletion).toMatchObject({ code: 'approval-required', risk_id: GATED });
    expect(deletion.fingerprint).toBe(first.fingerprint);
    expect(await rig.root.store.approvals.listActive(rig.mission.mission.id)).toHaveLength(1);

    expect((await write()).error).toBeUndefined();
    expect(writesUpstream()).toHaveLength(1);
  });

  it('a file write outside .github/workflows never meets the gate', async () => {
    const plain = await write({ ...ARGS, path: 'README.md' });
    expect(plain.error).toBeUndefined();
    expect(await counters()).toEqual({ [UNGATED]: 1 });
    expect(await rig.root.requests.service.inbox(rig.ada)).toEqual([]);
  });

  it('the gate opened for the period lets every workflow write through, still counted', async () => {
    const first = refusalOf(await write());
    const decided = await rig.root.requests.service.decide(rig.ada, requestIdOf(first), {
      resolution: 'open-gate',
    });
    expect(decided).toMatchObject({ ok: true });
    expect((await write()).error).toBeUndefined();
    expect(
      (await write({ ...ARGS, path: '.github/workflows/release.yaml' })).error,
    ).toBeUndefined();
    expect(writesUpstream()).toHaveLength(2);
    expect(await counters()).toEqual({ [UNGATED]: 2, [GATED]: 2 });
    expect(await rig.root.store.approvals.listActive(rig.mission.mission.id)).toEqual([]);
  });

  it('the creator sets the gate to auto on the mission: the next call passes without a request', async () => {
    const edited = await rig.root.missions.service.setGate(
      rig.ada,
      rig.mission.mission.id,
      GATED,
      'auto',
    );
    expect(edited).toMatchObject({ ok: true, previous: 'approval' });
    expect((await write()).error).toBeUndefined();
    expect(await rig.root.requests.service.inbox(rig.ada)).toEqual([]);
  });

  it('the arguments are in the sealed request only: not in the audit, the events or the logs', async () => {
    const refusal = refusalOf(await write());
    const requestId = requestIdOf(refusal);
    const sealed = rig.root.store.db
      .prepare<[string], { args_blob: Buffer | null }>(
        'SELECT args_blob FROM requests WHERE id = ?',
      )
      .get(requestId);
    // Encrypted at rest with the instance's master key: the bytes do not read.
    expect(sealed?.args_blob).not.toBeNull();
    expect(sealed?.args_blob?.toString('utf8')).not.toContain('WORKFLOW-CONTENT-MARKER');

    await rig.root.requests.service.decide(rig.ada, requestId, { resolution: 'grant' });
    await write();

    const erased = rig.root.store.db
      .prepare<[string], { args_blob: Buffer | null }>(
        'SELECT args_blob FROM requests WHERE id = ?',
      )
      .get(requestId);
    expect(erased?.args_blob).toBeNull();
    const missionLog = await rig.root.store.missionLogs.getByMission(rig.mission.mission.id);
    for (const kept of [
      await rig.root.store.audit.list(),
      await rig.root.store.missionLogs.listEvents(missionLog?.id ?? ''),
      rig.logs,
    ]) {
      expect(JSON.stringify(kept)).not.toContain('WORKFLOW-CONTENT-MARKER');
    }
  });
});
