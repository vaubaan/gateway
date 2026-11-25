/**
 * Byte counts of a forwarded call (`bytes.ts`): the default meter, and what the
 * pipeline writes on the audit entry of each outcome.
 */
import { describe, expect, test } from 'vitest';

import { jsonBytes, jsonMeter, requestBytesOf, type CallMeter } from '../../src/bytes.ts';
import { MemoryAuditWriter } from '../../src/audit.ts';
import {
  CallPipeline,
  type CallPipelineDeps,
  type CallRequest,
  type UpstreamStage,
} from '../../src/pipeline.ts';
import { refuse } from '../../src/errors.ts';
import type { MissionAccount, MissionContext } from '../../src/types.ts';

const NOW = new Date('2026-11-15T10:00:00.000Z');

const account: MissionAccount = {
  id: 'acc_1',
  service: 'github',
  display_name: 'GitHub (acme)',
  status: 'active',
  owner: { kind: 'user', id: 'usr_1', display: 'ana@example.test' },
};

const ctx: MissionContext = {
  mission: {
    id: 'mis_1',
    name: 'Ship',
    status: 'active',
    creator_id: 'usr_1',
    expires_at: null,
    period: { kind: 'one-off' },
  },
  token: {
    id: 'tok_1',
    prefix: 'vbn_live_abcd1234',
    holder: { kind: 'member', user_id: 'usr_1', display: 'ana@example.test' },
  },
  accounts: [account],
  resources: [],
  resource_sets: [],
  policy: [],
  missionLog: null,
};

const call: CallRequest = {
  tool: 'github__get_file_contents',
  args: { path: 'README.md', note: 'é' },
  agent_label: null,
  client: { ip: null, user_agent: null },
};

function pipeline(over: Partial<CallPipelineDeps>) {
  const audit = new MemoryAuditWriter();
  const p = new CallPipeline({
    resources: { resolve: async () => ({ ok: true, target: { account, resource: null } }) },
    risks: { evaluate: async () => ({ kind: 'allow', risks_touched: [], executed_slices: [] }) },
    budget: {
      decide: async () => ({
        outcome: 'allowed',
        mission_log_id: 'ses_1',
        remaining: {},
        approval_id: null,
      }),
    },
    upstream: { execute: async () => ({ content: [{ type: 'text', text: 'hello' }] }) },
    audit,
    now: () => NOW,
    ...over,
  });
  return { p, audit };
}

describe('jsonBytes', () => {
  test('counts UTF-8 bytes of the JSON text, not characters', () => {
    expect(jsonBytes({ a: 'é' })).toBe('{"a":"é"}'.length + 1);
    expect(jsonBytes('x')).toBe(3);
  });

  test('what JSON cannot write counts nothing, and never throws', () => {
    expect(jsonBytes(undefined)).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(jsonBytes(cycle)).toBe(0);
    expect(jsonBytes(10n)).toBe(0);
  });
});

describe('requestBytesOf', () => {
  test('the door’s own count wins over the arguments (a git pack)', () => {
    expect(requestBytesOf({ ...call, payload_bytes: 4096 })).toBe(4096);
    expect(requestBytesOf(call)).toBe(jsonBytes(call.args));
  });
});

describe('the pipeline counts the bytes of a forwarded call', () => {
  test('allowed: arguments up, result down, on the entry', async () => {
    const { p, audit } = pipeline({});
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('allowed');
    expect(audit.calls[0]).toMatchObject({
      request_bytes: jsonBytes(call.args),
      response_bytes: jsonBytes({ content: [{ type: 'text', text: 'hello' }] }),
    });
  });

  test('failed upstream: what went up is counted, nothing came back', async () => {
    const failing: UpstreamStage = {
      execute: async () => {
        throw new Error('boom');
      },
    };
    const { p, audit } = pipeline({ upstream: failing });
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('failed');
    expect(audit.calls[0]).toMatchObject({
      request_bytes: jsonBytes(call.args),
      response_bytes: null,
    });
  });

  test('refused: nothing went to the service, no count', async () => {
    const { p, audit } = pipeline({
      budget: {
        decide: async () => ({
          outcome: 'refused',
          refusal: refuse.budgetExhausted({
            risk_id: 'github.read',
            quota: 1,
            consumed: 1,
            period_end: null,
            claim_url: 'https://gateway.example.test/r/req_1',
          }),
        }),
      },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('refused');
    expect(audit.calls[0]?.request_bytes ?? null).toBeNull();
    expect(audit.calls[0]?.response_bytes ?? null).toBeNull();
  });

  test('a door’s meter is used, and one that throws counts nothing without failing the call', async () => {
    const meter: CallMeter = {
      measure: () => ({ request_bytes: 7, response_bytes: 11 }),
    };
    const counted = pipeline({ meter });
    await counted.p.execute(ctx, call);
    expect(counted.audit.calls[0]).toMatchObject({ request_bytes: 7, response_bytes: 11 });

    const broken = pipeline({
      meter: {
        measure: () => {
          throw new Error('meter bug');
        },
      },
    });
    const out = await broken.p.execute(ctx, call);
    expect(out.kind).toBe('allowed');
    expect(broken.audit.calls[0]).toMatchObject({ request_bytes: null, response_bytes: null });
  });

  test('the default meter, read directly', () => {
    expect(jsonMeter.measure(call, { failed: true })).toEqual({
      request_bytes: jsonBytes(call.args),
      response_bytes: null,
    });
  });
});
