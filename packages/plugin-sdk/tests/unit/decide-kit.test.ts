/**
 * `decideCall` decides a call the way the gateway's risk step does : the
 * plugin's classifier, then the engine with the environment of the mission's
 * resources.
 */
import { describe, expect, test } from 'vitest';

import type { Resource } from '@vaubaan/shared';

import { decideCall } from '../../src/testing/index.ts';
import { acmePlugin } from '../fixtures/acme/acme-plugin.ts';

const space = (env?: string): Resource => ({
  service: 'acme',
  ref: 'sp-1',
  displayName: 'Space',
  ...(env === undefined ? {} : { env }),
});
const rename = { space: 'sp-1', thing_id: 't-1', name: 'n' };

describe('decideCall', () => {
  test('allows a call whose touched risks the mission accepted, qualified by environment', () => {
    expect(
      decideCall(acmePlugin, {
        tool: 'acme__update_thing',
        args: rename,
        resources: [space('staging')],
        accepted: ['acme[staging].thing-write'],
      }),
    ).toEqual({ outcome: 'allowed', risks_touched: ['acme[staging].thing-write'] });
  });

  test('refuses the same risk accepted for another environment, naming what is missing', () => {
    const decision = decideCall(acmePlugin, {
      tool: 'acme__update_thing',
      args: rename,
      resources: [space('prod')],
      accepted: ['acme[staging].thing-write'],
    });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') return;
    expect(decision.missing_risks).toEqual(['acme[prod].thing-write']);
  });

  test("reports the classifier's own refusal before any risk", () => {
    expect(
      decideCall(acmePlugin, {
        tool: 'acme__nope',
        args: { space: 'sp-1' },
        resources: [space('staging')],
        accepted: [],
      }),
    ).toEqual({ outcome: 'classify-denied', reason: "unknown tool 'acme__nope'" });
  });
});
