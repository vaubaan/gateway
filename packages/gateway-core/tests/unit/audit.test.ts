/**
 * The audit entry shape and the in-memory writer over both entry kinds. The
 * argument hash itself is covered by `fingerprint.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { MemoryAuditWriter, type AdminAuditEntry, type CallAuditEntry } from '../../src/audit.ts';
import { fingerprintArguments } from '../../src/fingerprint.ts';

const callEntry: CallAuditEntry = {
  kind: 'call',
  ts: '2026-10-13T10:00:00.000Z',
  mission_id: 'mis_1',
  token_id: null,
  token_kind: null,
  token_holder: null,
  session_id: 'ses_1',
  account_id: 'con_1',
  resource_ref: 'acme/api',
  tool: 'github__create_pull_request',
  arguments_hash: fingerprintArguments({ title: 'x' }),
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
        'token_id',
        'token_kind',
        'token_holder',
        'session_id',
        'account_id',
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
