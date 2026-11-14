/**
 * The classifier sees the account's public form fields (see
 * docs/handbook/plugin-sdk.md): a refused `fly__create_app` in a
 * mission with no Fly app cites `fly.org[<the account's org>].app.W`, not
 * `fly.org[*]` (dogfood, 2026-10-16). Both stages hand the same view; nothing
 * but the visible fields reaches the plugin.
 */
import type { CallRequest, MissionAccount, MissionContext } from '@vaubaan/gateway-core';
import flyPlugin from '@vaubaan/plugin-fly';
import { createRegistry, serializeSlice } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { accountPublicFields } from '../accounts/mapping';
import { classifyAccountOf, createResourceStage } from './resource-stage';
import { createRiskStage } from './risk-stage';

const registry = createRegistry([flyPlugin]);

function account(publicFields?: Record<string, string>): MissionAccount {
  return {
    id: 'conn-fly',
    provider: 'fly',
    display_name: 'Fly (vaubaan)',
    status: 'active',
    owner: { kind: 'user', id: 'u1', display: 'ada@example.com' },
    ...(publicFields ? { public_fields: publicFields } : {}),
  };
}

function context(conn: MissionAccount): MissionContext {
  return {
    mission: {
      id: 'm1',
      name: 'Create an app',
      status: 'active',
      creator_id: 'u1',
      expires_at: null,
      period: { kind: 'one-off' },
    },
    token: { id: 't1', prefix: 'p', holder: { kind: 'named', name: 'agent' } },
    accounts: [conn],
    resources: [],
    resource_sets: [{ id: 'set-1', account_id: conn.id, position: 1, resource_ids: [] }],
    policy: [],
    session: null,
  } as unknown as MissionContext;
}

const createApp: CallRequest = {
  tool: 'fly__create_app',
  args: { name: 'beta-gw', network: 'beta-net' },
  agent_label: null,
  client: { ip: null },
} as unknown as CallRequest;

async function citedSlices(conn: MissionAccount): Promise<string[]> {
  const ctx = context(conn);
  const resolved = await createResourceStage({
    registry,
    accounts: { listResources: async () => [] },
  }).resolve(ctx, createApp);
  if (!resolved.ok) throw new Error('resource stage refused');
  const verdict = await createRiskStage({ registry }).evaluate(ctx, createApp, resolved.target);
  if (verdict.kind !== 'deny') throw new Error(`expected a refusal, got ${verdict.kind}`);
  return verdict.executed_slices.map(serializeSlice);
}

describe("the classifier is shown the account's public fields", () => {
  it("a refused creation names the account's organization", async () => {
    expect(await citedSlices(account({ org_slug: 'vaubaan' }))).toEqual(['fly.org[vaubaan].app.W']);
  });

  it('without them, the organization stays any (fail-closed: the same risk is touched)', async () => {
    expect(await citedSlices(account())).toEqual(['fly.org[*].app.W']);
  });

  it('the view is the visible fields and nothing else', () => {
    expect(classifyAccountOf(account({ org_slug: 'vaubaan' }))).toEqual({
      fields: { org_slug: 'vaubaan' },
    });
    expect(classifyAccountOf(account())).toEqual({ fields: {} });
  });

  it('only string fields of the stored metadata are public fields', () => {
    expect(
      accountPublicFields({
        metadata: {
          fields: { org_slug: 'vaubaan', n: 1 },
          account: 'x',
          credential_kind: 'api-key',
        },
      }),
    ).toEqual({ org_slug: 'vaubaan' });
    expect(accountPublicFields({ metadata: null })).toEqual({});
    expect(accountPublicFields({ metadata: { fields: ['org_slug'] } })).toEqual({});
  });
});
