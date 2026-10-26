/**
 * The call pipeline behind the execution door, end to end inside the process:
 * the real composition root on the `:memory:` store, a scripted fixture plugin
 * (`depot`), missions issued through the mission service, calls sent as
 * JSON-RPC to the door's handler.
 *
 * Spec §4.1 (call, the structured refusals and their fields), §2.4 (no
 * credential to the executor), §3.1 (resource selection), §7.5, §8 (audit),
 * §10 "structured refusals: every code, every field, the hint".
 */
import {
  fingerprintArguments,
  REFUSAL_CODES,
  REFUSAL_RPC_CODE,
  type CallAuditEntry,
} from '@vaubaan/gateway-core';
import { UpstreamAuthError } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CALL_REJECTED_RPC_CODE } from '../../../src/server/execution';
import { agePastStaleGrace } from '../../../src/server/store/testing';
import {
  DEPOT_API_KEY,
  depotSecret,
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type IssuedMission,
  type RpcBody,
} from '../../../src/server/execution/testing';

const READ = 'depot.read';
const WRITE_STAGING = 'depot[staging].write';
const PURGE = 'depot.purge';

describe('execution door: the call pipeline', () => {
  let instance: ExecutionInstance;

  beforeEach(async () => {
    instance = await executionInstance();
  });
  afterEach(async () => {
    await instance.close();
  });

  async function callEntries(mission: IssuedMission): Promise<CallAuditEntry[]> {
    const records = await instance.root.store.audit.list({
      missionId: mission.mission.id,
      kind: 'call',
    });
    return records as unknown as CallAuditEntry[];
  }

  async function consumed(mission: IssuedMission, riskId: string): Promise<number> {
    const session = await instance.root.store.sessions.getByMission(mission.mission.id);
    if (!session) return 0;
    const counters = await instance.root.store.sessions.counters(session.id);
    return counters.filter((c) => c.riskId === riskId).reduce((sum, c) => sum + c.consumed, 0);
  }

  /** The refusal carried by a JSON-RPC error, with the envelope checked. */
  function refusalOf(body: RpcBody, code: string): Record<string, unknown> {
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(REFUSAL_RPC_CODE);
    expect(body.error?.message).toBe(`Vaubaan refused the call: ${code}`);
    const data = body.error?.data ?? {};
    expect(data.code).toBe(code);
    expect(typeof data.hint).toBe('string');
    expect((data.hint as string).length).toBeGreaterThan(20);
    return data;
  }

  describe('allowed call', () => {
    it('forwards to the plugin, decrements the touched risk and writes one audit entry', async () => {
      const mission = await instance.issue({ policy: [line(READ, 5)] });
      const args = { space: 'scratch', item: 'readme' };

      const body = await instance.call(mission, 'depot__read_item', args);

      expect(body.error).toBeUndefined();
      expect(body.result?.content).toEqual([
        { type: 'text', text: JSON.stringify({ tool: 'depot__read_item', args }) },
      ]);
      expect(instance.depot.calls).toHaveLength(1);
      expect(await consumed(mission, READ)).toBe(1);

      const entries = await callEntries(mission);
      expect(entries).toHaveLength(1);
      const session = await instance.root.store.sessions.getByMission(mission.mission.id);
      expect(entries[0]).toMatchObject({
        kind: 'call',
        mission_id: mission.mission.id,
        // The token the call presented and its holder: the creator's own member token.
        token_id: expect.any(String) as string,
        token_kind: 'member',
        token_holder: mission.mission.creatorUserId,
        session_id: session?.id,
        connection_id: instance.connection.id,
        resource_ref: 'scratch',
        tool: 'depot__read_item',
        arguments_hash: fingerprintArguments(args),
        risks_touched: [READ],
        accepted_risks_snapshot: [READ],
        decision: 'allowed',
        refusal_code: null,
        remaining_budget: { [READ]: 4 },
        upstream_error: null,
      });
      expect(entries[0]?.arguments_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(entries[0]?.upstream_latency_ms).toBeGreaterThanOrEqual(0);
    });

    it('hands the decrypted credential to the plugin and never to the executor', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });
      const { status, body } = await instance.rpc(mission.token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'depot__read_item', arguments: { space: 'scratch' } },
      });
      expect(status).toBe(200);
      const ctx = instance.depot.calls[0]?.ctx;
      expect(ctx?.credential).toEqual(depotSecret());
      // The plugin sees the mission's resources on the connection, nothing else of the mission.
      expect(ctx?.resources.map((r) => r.ref).sort()).toEqual([
        'app-prod',
        'app-staging',
        'scratch',
      ]);
      expect(JSON.stringify(body)).not.toContain(DEPOT_API_KEY);
    });

    it('matches an env-qualified risk through the label of the resource the call touches', async () => {
      const mission = await instance.issue({ policy: [line(READ), line(WRITE_STAGING, 3)] });

      const staging = await instance.call(mission, 'depot__write_item', { space: 'app-staging' });
      expect(staging.error).toBeUndefined();
      expect(await consumed(mission, WRITE_STAGING)).toBe(1);

      // Same tool on the prod resource: the mission accepted the staging entry only.
      const prod = await instance.call(mission, 'depot__write_item', { space: 'app-prod' });
      expect(refusalOf(prod, 'risk-not-accepted').missing_risks).toEqual(['depot[prod].write']);
    });

    it("reads an unlabelled resource under the connection's default environment, and only while it is set", async () => {
      const mission = await instance.issue({ policy: [line(READ), line(WRITE_STAGING, 3)] });
      const { connections } = instance.root.store;

      // `scratch` carries no label: an env-qualified risk is refused on it.
      const before = await instance.call(mission, 'depot__write_item', { space: 'scratch' });
      refusalOf(before, 'risk-not-accepted');

      // The owner gives the account a default: the same call matches `depot[staging].write`.
      await connections.setDefaultEnv(instance.connection.id, 'staging');
      const after = await instance.call(mission, 'depot__write_item', { space: 'scratch' });
      expect(after.error).toBeUndefined();
      expect(await consumed(mission, WRITE_STAGING)).toBe(1);
      // A resource's own label still wins over the default.
      const prod = await instance.call(mission, 'depot__write_item', { space: 'app-prod' });
      expect(refusalOf(prod, 'risk-not-accepted').missing_risks).toEqual(['depot[prod].write']);

      // Cleared: refused again.
      await connections.setDefaultEnv(instance.connection.id, null);
      const cleared = await instance.call(mission, 'depot__write_item', { space: 'scratch' });
      refusalOf(cleared, 'risk-not-accepted');
    });

    it('records the agent label from the header, and prefers the per-call `_meta.agent`', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });
      await instance.call(
        mission,
        'depot__read_item',
        { space: 'scratch' },
        { 'x-vaubaan-agent': 'reviewer' },
      );
      await instance.rpc(
        mission.token,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'depot__read_item',
            arguments: { space: 'scratch' },
            _meta: { agent: 'planner' },
          },
        },
        { 'x-vaubaan-agent': 'reviewer', 'user-agent': 'claude-code/2' },
      );
      const entries = await callEntries(mission);
      expect(entries.map((e) => e.agent_label)).toEqual(['reviewer', 'planner']);
      expect(entries[1]?.client_user_agent).toBe('claude-code/2');
      // Both labels spend the same budget.
      expect(await consumed(mission, READ)).toBe(2);
      expect(instance.depot.calls[1]?.ctx.agentLabel).toBe('planner');
    });
  });

  describe('structured refusals — every code, every field, the hint', () => {
    it('covers the nine codes of the spec', () => {
      expect([...REFUSAL_CODES].sort()).toEqual(
        [
          'approval-required',
          'budget-exhausted',
          'connection-revoked',
          'connection-unavailable',
          'mission-inactive',
          'rate-limited',
          'resource-not-in-mission',
          'risk-not-accepted',
          'wrong-credential-kind',
        ].sort(),
      );
    });

    it('risk-not-accepted: missing risks and executed slices; nothing counted, nothing executed', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });
      const body = await instance.call(mission, 'depot__purge', { space: 'scratch' });

      const refusal = refusalOf(body, 'risk-not-accepted');
      expect(refusal.missing_risks).toEqual([PURGE]);
      expect(refusal.executed_slices).toHaveLength(1);
      expect(refusal.hint).toContain(PURGE);
      expect(instance.depot.calls).toHaveLength(0);
      expect(await instance.root.store.sessions.getByMission(mission.mission.id)).toBeNull();
      const [entry] = await callEntries(mission);
      expect(entry).toMatchObject({
        decision: 'refused',
        refusal_code: 'risk-not-accepted',
        risks_touched: [PURGE],
        remaining_budget: null,
      });
    });

    it('budget-exhausted: risk, quota, consumed, end of period and the claim URL', async () => {
      const mission = await instance.issue({ policy: [line(READ, 1)] });
      expect((await instance.call(mission, 'depot__read_item', { space: 'scratch' })).error).toBe(
        undefined,
      );

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      const refusal = refusalOf(body, 'budget-exhausted');
      expect(refusal).toMatchObject({ risk_id: READ, quota: 1, consumed: 1 });
      expect(Date.parse(refusal.period_end as string)).toBeGreaterThan(Date.now());
      expect(refusal.claim_url).toMatch(new RegExp(`^${TEST_PUBLIC_URL}/r/[A-Za-z0-9_-]+$`));
      expect(refusal.hint).toContain(refusal.claim_url as string);
      expect(instance.depot.calls).toHaveLength(1);
      expect(await consumed(mission, READ)).toBe(1);
      expect((await callEntries(mission)).map((e) => e.decision)).toEqual(['allowed', 'refused']);
    });

    it('approval-required: risk, fingerprint, approval URL and validity; nothing executed', async () => {
      const mission = await instance.issue({
        policy: [line(READ), line(PURGE, 2, { gate: 'approval' })],
      });
      const args = { space: 'scratch' };

      const body = await instance.call(mission, 'depot__purge', args);

      const refusal = refusalOf(body, 'approval-required');
      expect(refusal.risk_id).toBe(PURGE);
      expect(refusal.fingerprint).toBe(fingerprintArguments(args));
      expect(refusal.approval_url).toMatch(new RegExp(`^${TEST_PUBLIC_URL}/r/`));
      expect(Date.parse(refusal.expires_at as string)).toBeGreaterThan(Date.now());
      expect(instance.depot.calls).toHaveLength(0);
      expect(await consumed(mission, PURGE)).toBe(0);
      // One hash everywhere: the audit entry carries the fingerprint the approval binds.
      expect((await callEntries(mission))[0]?.arguments_hash).toBe(refusal.fingerprint);
    });

    it('resource-not-in-mission: the cited ref, the connection, the allowed resources — before any risk', async () => {
      const mission = await instance.issue({ policy: [line(READ)], spaces: ['scratch'] });

      const body = await instance.call(mission, 'depot__read_item', { space: 'app-prod' });

      const refusal = refusalOf(body, 'resource-not-in-mission');
      expect(refusal.cited_ref).toBe('app-prod');
      expect(refusal.connection).toEqual({ id: instance.connection.id, name: 'Depot main' });
      expect(refusal.allowed_resources).toEqual([
        { ref: 'scratch', env: null, display_name: 'scratch' },
      ]);
      expect(instance.depot.calls).toHaveLength(0);
      const [entry] = await callEntries(mission);
      expect(entry).toMatchObject({
        decision: 'refused',
        refusal_code: 'resource-not-in-mission',
        risks_touched: [],
        slices_executed: [],
      });
    });

    it('resource-not-in-mission also for a selected resource that went stale; a hidden one still works', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });
      const { connections } = instance.root.store;
      const scratch = instance.resources.find((r) => r.ref === 'scratch');
      await connections.setResourceHidden(scratch?.id ?? '', true);
      // The next discovery no longer returns app-prod (seen long ago: past the grace).
      agePastStaleGrace(instance.root.store, instance.connection.id);
      await connections.syncDiscoveredResources(instance.connection.id, [
        { ref: 'app-staging', displayName: 'app-staging' },
        { ref: 'scratch', displayName: 'scratch' },
      ]);

      const hidden = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      expect(hidden.error).toBeUndefined();

      const stale = await instance.call(mission, 'depot__read_item', { space: 'app-prod' });
      const refusal = refusalOf(stale, 'resource-not-in-mission');
      expect(refusal.cited_ref).toBe('app-prod');
      expect((refusal.allowed_resources as { ref: string }[]).map((r) => r.ref).sort()).toEqual([
        'app-staging',
        'scratch',
      ]);
    });

    it('never hydrates "all resources" from the live list: a resource discovered later is not covered', async () => {
      const empty = await executionInstance({ spaces: [] });
      try {
        const mission = await empty.issue({ policy: [line(READ), line('depot.profile')] });
        expect(mission.mission.connections[0]).toMatchObject({
          resourceScope: 'all',
          resourceIds: [],
        });
        await empty.root.store.connections.syncDiscoveredResources(empty.connection.id, [
          { ref: 'late', displayName: 'late' },
        ]);

        const body = await empty.call(mission, 'depot__read_item', { space: 'late' });
        expect(body.error?.data).toMatchObject({
          code: 'resource-not-in-mission',
          cited_ref: 'late',
          allowed_resources: [],
        });
        // An account-level tool needs no resource.
        expect((await empty.call(mission, 'depot__whoami')).error).toBeUndefined();
      } finally {
        await empty.close();
      }
    });

    it('the whole connection: a resource discovered after issuance is reached, a hidden or vanished one is not', async () => {
      const empty = await executionInstance({ spaces: [] });
      try {
        const mission = await empty.issue({ policy: [line(READ)], wholeConnection: true });
        expect(mission.mission.connections[0]).toMatchObject({
          resourceScope: 'connection',
          resourceIds: [],
        });
        const { connections } = empty.root.store;
        const found = await connections.syncDiscoveredResources(empty.connection.id, [
          { ref: 'late', displayName: 'late' },
          { ref: 'kept-out', displayName: 'kept-out' },
        ]);
        await connections.setResourceHidden(
          found.find((r) => r.ref === 'kept-out')?.id ?? '',
          true,
        );

        const late = await empty.call(mission, 'depot__read_item', { space: 'late' });
        expect(late.error).toBeUndefined();
        // The plugin sees the live list, so a "list" tool filtered to the mission shows it.
        expect(empty.depot.calls.at(-1)?.ctx.resources.map((r) => r.ref)).toEqual(['late']);

        const hidden = await empty.call(mission, 'depot__read_item', { space: 'kept-out' });
        expect(hidden.error?.data).toMatchObject({
          code: 'resource-not-in-mission',
          allowed_resources: [{ ref: 'late', env: null, display_name: 'late' }],
        });

        // The next discovery no longer returns `late`: the mission no longer reaches it
        // (once `late` is past the grace of a fresh row).
        agePastStaleGrace(empty.root.store, empty.connection.id);
        await connections.syncDiscoveredResources(empty.connection.id, [
          { ref: 'kept-out', displayName: 'kept-out' },
        ]);
        const gone = await empty.call(mission, 'depot__read_item', { space: 'late' });
        expect(gone.error?.data).toMatchObject({
          code: 'resource-not-in-mission',
          cited_ref: 'late',
          allowed_resources: [],
        });
      } finally {
        await empty.close();
      }
    });

    it('rate-limited: risk, limit and delay; the quota is not consumed', async () => {
      const mission = await instance.issue({
        policy: [line(READ, 10, { rate_limit: { max: 1, window_seconds: 60 } })],
      });
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      const refusal = refusalOf(body, 'rate-limited');
      expect(refusal.risk_id).toBe(READ);
      expect(refusal.limit).toEqual({ max: 1, window_seconds: 60 });
      expect(refusal.retry_after_seconds).toBeGreaterThanOrEqual(1);
      expect(refusal.retry_after_seconds).toBeLessThanOrEqual(60);
      expect(await consumed(mission, READ)).toBe(1);
      expect(instance.depot.calls).toHaveLength(1);
    });

    it('connection-unavailable: an expired connection, its name and the owner to contact', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });
      await instance.root.store.connections.markExpired(instance.connection.id);

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      const refusal = refusalOf(body, 'connection-unavailable');
      expect(refusal.connection).toEqual({ id: instance.connection.id, name: 'Depot main' });
      expect(refusal.status).toBe('expired');
      expect(refusal.owner).toEqual({ kind: 'user', display: 'ada@example.com' });
      expect(refusal.hint).toContain('ada@example.com');
      expect(instance.depot.calls).toHaveLength(0);
      expect(await consumed(mission, READ)).toBe(0);
    });

    it('mission-inactive: a revoked connection orphans a mission it was the only connection of, as a derived state (spec §7.8)', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });
      // Revoked behind the services' back: the door's own re-check must see it.
      await instance.root.store.connections.revoke(instance.connection.id);

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      const refusal = refusalOf(body, 'mission-inactive');
      expect(refusal.status).toBe('orphaned');
      expect(typeof refusal.reason).toBe('string');
      expect(refusal.hint).toContain('orphaned');
      // Derived for this request only: the door wrote no verdict.
      expect((await instance.root.store.missions.getById(mission.mission.id))?.status).toBe(
        'active',
      );
      expect((await callEntries(mission))[0]?.refusal_code).toBe('mission-inactive');
      expect(instance.depot.calls).toHaveLength(0);
      expect(await consumed(mission, READ)).toBe(0);
    });

    it('mission-inactive: a revoked mission and an expired one, with the reason', async () => {
      const revoked = await instance.issue({ policy: [line(READ)], name: 'Revoked' });
      await instance.root.missions.service.revoke(instance.ada, revoked.mission.id);
      const afterRevoke = await instance.call(revoked, 'depot__read_item', { space: 'scratch' });
      const refusal = refusalOf(afterRevoke, 'mission-inactive');
      expect(refusal.status).toBe('revoked');
      expect(typeof refusal.reason).toBe('string');
      expect((await callEntries(revoked))[0]?.refusal_code).toBe('mission-inactive');

      const expired = await instance.issue({ policy: [line(READ)], name: 'Expired' });
      await instance.root.store.missions.setExpiresAt(
        expired.mission.id,
        new Date(Date.now() - 1000).toISOString(),
      );
      const afterExpiry = await instance.call(expired, 'depot__read_item', { space: 'scratch' });
      expect(refusalOf(afterExpiry, 'mission-inactive').status).toBe('expired');

      // Discovery is refused the same way: an inactive mission lists nothing.
      const { body: list } = await instance.rpc(expired.token, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/list',
      });
      expect(list.error?.data).toMatchObject({ code: 'mission-inactive', status: 'expired' });
      expect(instance.depot.calls).toHaveLength(0);
    });
  });

  describe('structural rejections (no refusal code)', () => {
    it('rejects an unknown tool, a provider the mission has no connection for, and unplaceable arguments', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });

      const unknown = await instance.call(mission, 'nope__anything');
      expect(unknown.error?.code).toBe(CALL_REJECTED_RPC_CODE);
      expect(unknown.error?.message).toContain("unknown tool 'nope__anything'");

      const noArgs = await instance.call(mission, 'depot__read_item', { space: 'Not A Ref' });
      expect(noArgs.error?.code).toBe(CALL_REJECTED_RPC_CODE);
      expect(noArgs.error?.data).toEqual({ reason: "space 'Not A Ref' is not a valid ref." });

      const entries = await callEntries(mission);
      expect(entries.map((e) => [e.decision, e.refusal_code])).toEqual([
        ['refused', null],
        ['refused', null],
      ]);
      expect(entries[0]?.refusal_reason).toContain('unknown tool');
      expect(instance.depot.calls).toHaveLength(0);
    });

    it('a classifier that throws: the call is refused, AUDITED, counted nowhere, and its text reaches neither the audit nor the log', async () => {
      const logs: string[] = [];
      const logged = await executionInstance({
        deps: { logWrite: (_level, text) => logs.push(text) },
      });
      try {
        const mission = await logged.issue({ policy: [line(READ, 5)] });
        const args = { space: 'scratch', item: 'payroll-2026.xlsx' };
        logged.depot.breakClassifier((_tool, given) => {
          // What a real bug looks like: the error quotes what it choked on.
          return new TypeError(`cannot classify item '${String(given.item)}'`);
        });

        const body = await logged.call(mission, 'depot__read_item', args);

        expect(body.result).toBeUndefined();
        expect(body.error?.code).toBe(CALL_REJECTED_RPC_CODE);
        expect(body.error?.message).toContain('the risk stage failed (TypeError)');
        expect(JSON.stringify(body)).not.toContain('payroll');
        expect(logged.depot.calls).toHaveLength(0);

        const records = await logged.root.store.audit.list({
          missionId: mission.mission.id,
          kind: 'call',
        });
        const entries = records as unknown as CallAuditEntry[];
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          decision: 'refused',
          refusal_code: null,
          tool: 'depot__read_item',
          arguments_hash: fingerprintArguments(args),
          token_holder: mission.mission.creatorUserId,
          connection_id: logged.connection.id,
          risks_touched: [],
          remaining_budget: null,
        });
        expect(entries[0]?.refusal_reason).toContain('the risk stage failed (TypeError)');
        expect(JSON.stringify(entries[0])).not.toContain('payroll');
        // Nothing was counted: the next good call still has the whole quota.
        logged.depot.breakClassifier(null);
        const ok = await logged.call(mission, 'depot__read_item', args);
        expect(ok.error).toBeUndefined();
        const after = (await logged.root.store.audit.list({
          missionId: mission.mission.id,
          kind: 'call',
        })) as unknown as CallAuditEntry[];
        expect(after.find((e) => e.decision === 'allowed')?.remaining_budget).toEqual({
          [READ]: 4,
        });

        const failure = logs
          .map((text) => JSON.parse(text) as Record<string, unknown>)
          .filter((entry) => entry.msg === 'call refused: a decision stage failed');
        expect(failure).toHaveLength(1);
        expect(failure[0]).toMatchObject({
          level: 'error',
          stage: 'risk',
          tool: 'depot__read_item',
          error_class: 'TypeError',
        });
        expect((failure[0]?.stack_frames as string[]).length).toBeGreaterThan(0);
        expect(logs.join('')).not.toContain('payroll');
      } finally {
        await logged.close();
      }
    });
  });

  describe('upstream', () => {
    it('reports a provider failure as a tool error; the call stays allowed and counted', async () => {
      const mission = await instance.issue({ policy: [line(READ, 5)] });
      instance.depot.script(async () => {
        throw new Error('depot answered 502');
      });

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Upstream error: depot answered 502' }],
      });
      expect(await consumed(mission, READ)).toBe(1);
      expect((await callEntries(mission))[0]).toMatchObject({
        decision: 'allowed',
        upstream_error: 'depot call failed (Error)',
        remaining_budget: { [READ]: 4 },
      });
    });

    it("keeps the provider's text out of the audit: a host-built summary there, the detail to the agent", async () => {
      // Providers echo input in their errors (an object id, a SQL fragment), and
      // plugins quote the provider's body in the error they throw.
      const marker = 'item-marker-7f3a9c';
      const mission = await instance.issue({ policy: [line(READ, 5)] });
      instance.depot.script(async (_ctx, _tool, args) => {
        const item = String(args.item);
        throw new UpstreamAuthError(`depot GET /items/${item} 403: no item '${item}' here`, 403);
      });

      const body = await instance.call(mission, 'depot__read_item', {
        space: 'scratch',
        item: marker,
      });

      // The agent, which knows its own arguments, reads the provider's answer.
      expect(body.result).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: `Upstream error: depot GET /items/${marker} 403: no item '${marker}' here`,
          },
        ],
      });
      // The audit holds the provider id, the status and the error class — nothing else.
      const [entry] = await callEntries(mission);
      expect(entry?.upstream_error).toBe('depot answered HTTP 403 (UpstreamAuthError)');
      expect(JSON.stringify(entry)).not.toContain(marker);
      const stored = await instance.root.store.audit.list({ missionId: mission.mission.id });
      expect(JSON.stringify(stored)).not.toContain(marker);
    });

    it('names the HTTP status an HTTP client put on its error, and nothing of its message', async () => {
      const mission = await instance.issue({ policy: [line(READ, 5)] });
      instance.depot.script(async () => {
        throw Object.assign(new Error('Validation Failed: "q" is too long'), { status: 422 });
      });

      await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      expect((await callEntries(mission))[0]?.upstream_error).toBe(
        'depot answered HTTP 422 (Error)',
      );
    });

    it('401 → refresh → retry with the new credential; the connection stays active', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });
      instance.depot.scriptRefresh(async () => depotSecret('sk-rotated'));
      instance.depot.script(async (ctx) => {
        const token = ctx.credential.kind === 'api-key' ? ctx.credential.fields.token : '';
        if (token !== 'sk-rotated') throw new UpstreamAuthError('bad key', 401);
        return { content: [{ type: 'text', text: 'ok' }] };
      });

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      expect(body.result?.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(instance.depot.calls).toHaveLength(2);
      const connection = await instance.root.store.connections.getById(instance.connection.id);
      expect(connection?.status).toBe('active');
      expect((await callEntries(mission))[0]).toMatchObject({
        decision: 'allowed',
        upstream_error: null,
      });
    });

    it('401 and a rejected refresh → the connection is expired and the agent reads connection-unavailable', async () => {
      const mission = await instance.issue({ policy: [line(READ, 5)] });
      instance.depot.script(async () => {
        throw new UpstreamAuthError('bad key', 401);
      });

      const first = await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      const refusal = refusalOf(first, 'connection-unavailable');
      expect(refusal.status).toBe('expired');
      expect(refusal.owner).toEqual({ kind: 'user', display: 'ada@example.com' });
      const connection = await instance.root.store.connections.getById(instance.connection.id);
      expect(connection?.status).toBe('expired');
      // The decision stood: allowed and counted, with the failure on the entry.
      const [entry] = await callEntries(mission);
      expect(entry).toMatchObject({ decision: 'allowed', refusal_code: null });
      expect(entry?.upstream_error).toMatch(/^connection-unavailable: /);
      expect(await consumed(mission, READ)).toBe(1);

      // From now on the call is refused before the budget.
      instance.depot.script(null);
      const second = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      expect(refusalOf(second, 'connection-unavailable').status).toBe('expired');
      expect(await consumed(mission, READ)).toBe(1);
      expect((await callEntries(mission))[1]?.decision).toBe('refused');
    });

    it('403 is the provider refusing the action, not a dead credential: no refresh, no expiry', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });
      let refreshes = 0;
      instance.depot.scriptRefresh(async () => {
        refreshes += 1;
        return depotSecret('sk-rotated');
      });
      instance.depot.script(async () => {
        throw new UpstreamAuthError('the app lacks the permission', 403);
      });

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      expect(body.result).toMatchObject({ isError: true });
      expect(refreshes).toBe(0);
      expect(instance.depot.calls).toHaveLength(1);
      const connection = await instance.root.store.connections.getById(instance.connection.id);
      expect(connection?.status).toBe('active');
    });

    it('serves a derived upstream credential from the connection-scoped cache, and drops it on 401', async () => {
      const mission = await instance.issue({ policy: [line(READ)] });
      let minted = 0;
      let rejectCached = false;
      instance.depot.scriptRefresh(async () => depotSecret());
      instance.depot.script(async (ctx) => {
        const cache = ctx.credentialCache;
        if (!cache) throw new Error('no credential cache in the execute context');
        let derived = await cache.get<string>('derived');
        const fromCache = derived !== null;
        if (derived === null) {
          minted += 1;
          derived = `derived-${minted}`;
          await cache.set('derived', derived, 600);
        }
        if (fromCache && rejectCached) {
          rejectCached = false;
          throw new UpstreamAuthError('derived token revoked', 401);
        }
        return { content: [{ type: 'text', text: fromCache ? 'cached' : 'minted' }] };
      });
      const text = (body: RpcBody) => (body.result?.content as { text: string }[])[0]?.text;

      expect(text(await instance.call(mission, 'depot__read_item', { space: 'scratch' }))).toBe(
        'minted',
      );
      expect(text(await instance.call(mission, 'depot__read_item', { space: 'scratch' }))).toBe(
        'cached',
      );
      expect(minted).toBe(1);

      // The provider rejects the cached credential: dropped, minted again, same stored credential.
      rejectCached = true;
      expect(text(await instance.call(mission, 'depot__read_item', { space: 'scratch' }))).toBe(
        'minted',
      );
      expect(minted).toBe(2);
      const connection = await instance.root.store.connections.getById(instance.connection.id);
      expect(connection?.status).toBe('active');

      // A revoked connection leaves nothing behind.
      await instance.root.store.connections.revoke(instance.connection.id);
      expect(await instance.root.execution.credentialCache.drop(instance.connection.id)).toBe(1);
    });
  });
});
