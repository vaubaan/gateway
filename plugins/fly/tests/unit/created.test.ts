/**
 * `createdResources` of the Fly plugin (ADR created-resources-join-the-mission):
 * the app `create_app` made — the name the call asked for, confirmed by the id
 * Fly answered (`POST /apps` answers `{ id, created_at }`).
 */
import { describe, expect, test } from 'vitest';

import { createdFlyResources, flyPlugin, TOOL } from '../../src/index.ts';

/** What `executeFly` returns for Fly's documented 201 answer. */
const answer = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
});

describe('fly createdResources', () => {
  test('the app the call named, with the id Fly answered', () => {
    expect(
      createdFlyResources(
        TOOL.createApp,
        { name: 'beta-gw', network: 'beta-net' },
        answer({ id: 'z4k69dxd8r31p5mx', created_at: 1708631799000 }),
      ),
    ).toEqual([
      {
        provider: 'fly',
        ref: 'beta-gw',
        displayName: 'beta-gw',
        metadata: { app_id: 'z4k69dxd8r31p5mx', network: 'beta-net' },
      },
    ]);
    expect(flyPlugin.createdResources).toBe(createdFlyResources);
  });

  test('nothing without a confirming id, with an app name outside the grammar, or for another app', () => {
    const args = { name: 'beta-gw', network: 'n' };
    expect(createdFlyResources(TOOL.createApp, args, answer({ created_at: 1 }))).toEqual([]);
    expect(createdFlyResources(TOOL.createApp, args, answer({ id: '../x' }))).toEqual([]);
    expect(
      createdFlyResources(TOOL.createApp, args, { content: [{ type: 'text', text: 'ok' }] }),
    ).toEqual([]);
    expect(
      createdFlyResources(TOOL.createApp, { name: 'Beta_GW', network: 'n' }, answer({ id: 'abc' })),
    ).toEqual([]);
    expect(
      createdFlyResources(TOOL.createApp, args, answer({ id: 'abc', name: 'other-app' })),
    ).toEqual([]);
    expect(createdFlyResources(TOOL.listApps, args, answer({ id: 'abc' }))).toEqual([]);
  });
});
