/**
 * The agent label through the door (spec §0 "Mission token", §3.2 "one budget
 * per mission, however many agents", §7.9, §8).
 *
 * A label is what a caller says about itself: it is written on the audit
 * entry and the session event of the call, and that is all. These tests hold
 * the other half of the sentence — "no effect on authorization" — over HTTP:
 *
 *   - several labels, and no label, draw from ONE counter;
 *   - a label does not open what the mission refuses, whatever it claims;
 *   - a value that is not a label is dropped with a logged reason and the
 *     call proceeds as if none had been sent: never a refusal;
 *   - `_meta.agent` wins over `X-Vaubaan-Agent`.
 */
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseEventDetails } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_LABEL_MAX_LENGTH } from '../../../src/server/execution';
import {
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type IssuedMission,
  type RpcBody,
} from '../../../src/server/execution/testing';

const READ = 'depot.read';
const TOOL = 'depot__read_item';
const ARGS = { space: 'scratch' };
const MODERN_REVISION = '2026-07-28';

interface LabelInstance extends ExecutionInstance {
  readonly logs: string[];
}

async function labelInstance(): Promise<LabelInstance> {
  const logs: string[] = [];
  const instance = await executionInstance({
    deps: { logWrite: (_level, text) => logs.push(text) },
  });
  return { ...instance, logs };
}

/** A `tools/call` with an optional header label and an optional `_meta.agent`. */
async function labelled(
  instance: ExecutionInstance,
  mission: IssuedMission,
  carriers: { header?: string; meta?: unknown; tool?: string } = {},
): Promise<RpcBody> {
  const { body } = await instance.rpc(
    mission.token,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: carriers.tool ?? TOOL,
        arguments: ARGS,
        ...('meta' in carriers ? { _meta: { agent: carriers.meta } } : {}),
      },
    },
    carriers.header === undefined ? {} : { 'x-vaubaan-agent': carriers.header },
  );
  return body;
}

describe('agent label: attribution only', () => {
  let instance: LabelInstance;

  beforeEach(async () => {
    instance = await labelInstance();
  });
  afterEach(async () => {
    await instance.close();
  });

  const entries = async (mission: IssuedMission) => {
    const all = await instance.root.store.audit.list({ missionId: mission.mission.id });
    return all.flatMap((e) => (e.kind === 'call' ? [e] : []));
  };
  const counter = async (mission: IssuedMission): Promise<number> => {
    const session = await instance.root.store.sessions.getByMission(mission.mission.id);
    if (!session) return 0;
    const rows = await instance.root.store.sessions.counters(session.id);
    return rows.filter((c) => c.riskId === READ).reduce((sum, c) => sum + c.consumed, 0);
  };

  it('two labels and no label share one counter: the fourth call is refused whoever asks', async () => {
    const mission = await instance.issue({ policy: [line(READ, 3)] });

    expect((await labelled(instance, mission, { header: 'planner' })).result).toBeDefined();
    expect((await labelled(instance, mission, { header: 'coder' })).result).toBeDefined();
    expect((await labelled(instance, mission)).result).toBeDefined();
    expect(await counter(mission)).toBe(3);

    // The quota is the mission's: a label that never called has nothing of its own.
    for (const carriers of [{ header: 'planner' }, { header: 'reviewer' }, {}]) {
      const refused = await labelled(instance, mission, carriers);
      expect(refused.error?.data).toMatchObject({ code: 'budget-exhausted', consumed: 3 });
    }
    expect(await counter(mission)).toBe(3);

    // One session, one counter row; the labels are on the entries and the events only.
    const session = await instance.root.store.sessions.getByMission(mission.mission.id);
    const counters = await instance.root.store.sessions.counters(session?.id ?? '');
    expect(counters).toHaveLength(1);
    expect((await entries(mission)).map((e) => [e.decision, e.agent_label])).toEqual([
      ['allowed', 'planner'],
      ['allowed', 'coder'],
      ['allowed', null],
      ['refused', 'planner'],
      ['refused', 'reviewer'],
      ['refused', null],
    ]);
    const events = await instance.root.store.sessions.listEvents(session?.id ?? '', {
      kinds: ['call-allowed'],
    });
    const labels = events.map((event) => {
      const parsed = parseEventDetails(event.kind, event.details);
      return parsed?.kind === 'call-allowed' ? parsed.details.agent_label : undefined;
    });
    expect(labels).toEqual(['planner', 'coder', null]);
  });

  it('decides the same with any label, with none, and with one that claims an identity', async () => {
    const mission = await instance.issue({ policy: [line(READ, 50)] });
    const other = await instance.issue({ policy: [line(READ, 50), line('depot.purge', 5)] });
    const claims = [
      undefined,
      'orchestrator',
      // Forged: the creator's email, another mission's id, the word an operator would use.
      instance.ada.email,
      other.mission.id,
      'admin',
      'root@gateway',
    ];

    for (const header of claims) {
      const carriers = header === undefined ? {} : { header };
      // Accepted by the mission: allowed.
      expect((await labelled(instance, mission, carriers)).result).toBeDefined();
      // Not accepted by this mission (the other one accepts it): refused, the same way.
      const purge = await labelled(instance, mission, { ...carriers, tool: 'depot__purge' });
      expect(purge.error?.data).toMatchObject({
        code: 'risk-not-accepted',
        missing_risks: ['depot.purge'],
      });
    }

    const all = await entries(mission);
    expect(all).toHaveLength(claims.length * 2);
    // Apart from the label (and the time), every allowed entry is the same decision.
    const decisions = new Set(
      all.map((e) =>
        JSON.stringify([e.tool, e.decision, e.refusal_code, e.risks_touched, e.connection_id]),
      ),
    );
    expect(decisions.size).toBe(2);
    expect(all.filter((e) => e.decision === 'allowed').map((e) => e.agent_label)).toEqual(
      claims.map((c) => c ?? null),
    );
    expect(await counter(mission)).toBe(claims.length);
    // The mission the forged label named is untouched.
    expect(await entries(other)).toHaveLength(0);
  });

  it('drops a value that is not a label, logs why, and serves the call', async () => {
    const mission = await instance.issue({ policy: [line(READ, 50)] });
    const tooLong = 'x'.repeat(AGENT_LABEL_MAX_LENGTH + 1);
    const cases: { carriers: { header?: string; meta?: unknown }; reason: string }[] = [
      { carriers: { header: tooLong }, reason: 'too-long' },
      { carriers: { header: 'build agent; drop table' }, reason: 'invalid-character' },
      { carriers: { meta: 'see <script>' }, reason: 'invalid-character' },
      { carriers: { meta: { name: 'planner' } }, reason: 'not-a-string' },
      { carriers: { meta: 42 }, reason: 'not-a-string' },
    ];

    for (const { carriers } of cases) {
      const body = await labelled(instance, mission, carriers);
      // Never a refusal, never an error: the call is served.
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    }

    expect((await entries(mission)).map((e) => [e.decision, e.agent_label])).toEqual(
      cases.map(() => ['allowed', null]),
    );
    expect(await counter(mission)).toBe(cases.length);

    const dropped = instance.logs
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'agent label dropped');
    expect(dropped.map((entry) => entry.reason)).toEqual(cases.map((c) => c.reason));
    expect(dropped[0]).toMatchObject({
      component: 'execution-door',
      mission_id: mission.mission.id,
      carrier: 'header',
      length: tooLong.length,
    });
    expect(dropped[2]).toMatchObject({ carrier: 'meta' });
    // The reason is logged; what was sent is not.
    const all = instance.logs.join('\n');
    expect(all).not.toContain(tooLong);
    expect(all).not.toContain('drop table');
    expect(all).not.toContain('<script>');
  });

  it('prefers `_meta.agent` over the header, and falls back to the header when it is rejected', async () => {
    const mission = await instance.issue({ policy: [line(READ, 50)] });

    await labelled(instance, mission, { header: 'reviewer', meta: 'planner' });
    await labelled(instance, mission, { header: 'reviewer', meta: 'not a label' });
    await labelled(instance, mission, { header: 'reviewer', meta: '   ' });
    await labelled(instance, mission, { header: '  coder  ' });

    expect((await entries(mission)).map((e) => e.agent_label)).toEqual([
      'planner',
      'reviewer',
      'reviewer',
      'coder',
    ]);
  });

  for (const era of ['2025-era', MODERN_REVISION] as const) {
    it(`an MCP client (${era}) labels a connection by header and one call by _meta`, async () => {
      const mission = await instance.issue({ policy: [line(READ, 2)] });
      const transport = new StreamableHTTPClientTransport(new URL(`${TEST_PUBLIC_URL}/mcp`), {
        fetch: (input, init) => instance.root.execution.handlers.mcp(new Request(input, init)),
        requestInit: {
          headers: { Authorization: `Bearer ${mission.token}`, 'X-Vaubaan-Agent': 'sub-agent-1' },
        },
      });
      const client = new Client(
        { name: 'label-test', version: '1.0.0' },
        era === MODERN_REVISION ? { versionNegotiation: { mode: { pin: MODERN_REVISION } } } : {},
      );
      await client.connect(transport);

      await client.callTool({ name: TOOL, arguments: ARGS });
      await client.callTool({ name: TOOL, arguments: ARGS, _meta: { agent: 'sub-agent-2' } });
      // Both drew from the same two actions.
      const third = await client
        .callTool({ name: TOOL, arguments: ARGS, _meta: { agent: 'sub-agent-3' } })
        .catch((err: unknown) => err);
      expect(third).toBeInstanceOf(ProtocolError);
      expect((third as ProtocolError).data).toMatchObject({ code: 'budget-exhausted' });

      expect((await entries(mission)).map((e) => [e.decision, e.agent_label])).toEqual([
        ['allowed', 'sub-agent-1'],
        ['allowed', 'sub-agent-2'],
        ['refused', 'sub-agent-3'],
      ]);
      await client.close();
    });
  }
});
