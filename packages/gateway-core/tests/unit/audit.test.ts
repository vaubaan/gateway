/**
 * Audit hashing (unchanged since v4: sha256 truncated to 16 hex) and the
 * in-memory writer over both entry kinds.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  MemoryAuditWriter,
  hashArguments,
  type AdminAuditEntry,
  type CallAuditEntry,
} from '../../src/index.ts';

describe('hashArguments', () => {
  test('sha256 of the JSON, truncated to 16 hex characters', () => {
    const args = { query: 'select 1', limit: 10 };
    const full = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    expect(hashArguments(args)).toBe(full.slice(0, 16));
    expect(hashArguments(args)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('known vector: empty object', () => {
    // sha256('{}') = 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
    expect(hashArguments({})).toBe('44136fa355b3678a');
  });

  test('undefined and null hash like an empty object', () => {
    expect(hashArguments(undefined)).toBe(hashArguments({}));
    expect(hashArguments(null)).toBe(hashArguments({}));
  });

  test('is deterministic and sensitive to a one-byte change', () => {
    expect(hashArguments({ a: 1 })).toBe(hashArguments({ a: 1 }));
    expect(hashArguments({ a: 1 })).not.toBe(hashArguments({ a: 2 }));
  });
});

const callEntry: CallAuditEntry = {
  kind: 'call',
  ts: '2026-10-13T10:00:00.000Z',
  mission_id: 'mis_1',
  session_id: 'ses_1',
  connection_id: 'con_1',
  resource_ref: 'acme/api',
  tool: 'github__create_pull_request',
  arguments_hash: hashArguments({ title: 'x' }),
  slices_executed: [],
  risks_touched: ['github.open-pull-request'],
  accepted_risks_snapshot: ['github.open-pull-request', 'github.read-repo'],
  decision: 'allowed',
  refusal_code: null,
  refusal_reason: null,
  approval_id: null,
  remaining_budget: { 'github.open-pull-request': 9 },
  agent_label: 'orchestrator',
  upstream_latency_ms: 120,
  upstream_error: null,
  client_ip: '10.0.0.1',
  client_user_agent: 'claude-code',
};

const adminEntry: AdminAuditEntry = {
  kind: 'admin',
  ts: '2026-10-13T10:01:00.000Z',
  user_id: 'usr_1',
  act: 'mission-issued',
  object: { type: 'mission', id: 'mis_1' },
  before: null,
  after: { name: 'Ship v2', status: 'active' },
  delegated_client_id: 'cli_claude',
};

describe('MemoryAuditWriter', () => {
  test('stores call and administrative entries and splits them by kind', async () => {
    const w = new MemoryAuditWriter();
    await w.write(callEntry);
    await w.write(adminEntry);
    expect(w.entries).toHaveLength(2);
    expect(w.calls).toEqual([callEntry]);
    expect(w.admin).toEqual([adminEntry]);
  });

  test('a call entry carries every spec §8 field', () => {
    const keys = Object.keys(callEntry).sort();
    expect(keys).toEqual(
      [
        'kind',
        'ts',
        'mission_id',
        'session_id',
        'connection_id',
        'resource_ref',
        'tool',
        'arguments_hash',
        'slices_executed',
        'risks_touched',
        'accepted_risks_snapshot',
        'decision',
        'refusal_code',
        'refusal_reason',
        'approval_id',
        'remaining_budget',
        'agent_label',
        'upstream_latency_ms',
        'upstream_error',
        'client_ip',
        'client_user_agent',
      ].sort(),
    );
  });
});
