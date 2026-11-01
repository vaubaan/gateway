/**
 * The classifier sees the connection's public form fields (see
 * docs/handbook/plugin-sdk.md): a refused `fly__create_app` in a
 * mission with no Fly app cites `fly.org[<the connection's org>].app.W`, not
 * `fly.org[*]` (dogfood, 2026-10-16). Both stages hand the same view; nothing
 * but the visible fields reaches the plugin.
 */
import type { CallRequest, MissionConnection, MissionContext } from '@vaubaan/gateway-core';
import flyPlugin from '@vaubaan/plugin-fly';
import { createRegistry, serializeSlice } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { connectionPublicFields } from '../connections/mapping';
import { classifyConnectionOf, createResourceStage } from './resource-stage';
import { createRiskStage } from './risk-stage';

const registry = createRegistry([flyPlugin]);

function connection(publicFields?: Record<string, string>): MissionConnection {
  return {
    id: 'conn-fly',
    provider: 'fly',
    display_name: 'Fly (vaubaan)',
    status: 'active',
    owner: { kind: 'user', id: 'u1', display: 'ada@example.com' },
    ...(publicFields ? { public_fields: publicFields } : {}),
  };
}

function context(conn: MissionConnection): MissionContext {
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
    connections: [conn],
    resources: [],
    resource_sets: [{ id: 'set-1', connection_id: conn.id, position: 1, resource_ids: [] }],
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

async function citedSlices(conn: MissionConnection): Promise<string[]> {
  const ctx = context(conn);
  const resolved = await createResourceStage({
    registry,
    connections: { listResources: async () => [] },
  }).resolve(ctx, createApp);
  if (!resolved.ok) throw new Error('resource stage refused');
  const verdict = await createRiskStage({ registry }).evaluate(ctx, createApp, resolved.target);
  if (verdict.kind !== 'deny') throw new Error(`expected a refusal, got ${verdict.kind}`);
  return verdict.executed_slices.map(serializeSlice);
}

describe("the classifier is shown the connection's public fields", () => {
  it("a refused creation names the connection's organization", async () => {
    expect(await citedSlices(connection({ org_slug: 'vaubaan' }))).toEqual([
      'fly.org[vaubaan].app.W',
    ]);
  });

  it('without them, the organization stays any (fail-closed: the same risk is touched)', async () => {
    expect(await citedSlices(connection())).toEqual(['fly.org[*].app.W']);
  });

  it('the view is the visible fields and nothing else', () => {
    expect(classifyConnectionOf(connection({ org_slug: 'vaubaan' }))).toEqual({
      fields: { org_slug: 'vaubaan' },
    });
    expect(classifyConnectionOf(connection())).toEqual({ fields: {} });
  });

  it('only string fields of the stored metadata are public fields', () => {
    expect(
      connectionPublicFields({
        metadata: {
          fields: { org_slug: 'vaubaan', n: 1 },
          account: 'x',
          credential_kind: 'api-key',
        },
      }),
    ).toEqual({ org_slug: 'vaubaan' });
    expect(connectionPublicFields({ metadata: null })).toEqual({});
    expect(connectionPublicFields({ metadata: { fields: ['org_slug'] } })).toEqual({});
  });
});
