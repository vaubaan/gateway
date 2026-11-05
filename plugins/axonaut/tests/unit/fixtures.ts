/**
 * Shared fixtures of the `axonaut` tests: the mission's account, the
 * execution context and the samples of every tool, which are the plugin's own
 * `examples` (`src/examples.ts`).
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { ACCOUNT, EXAMPLE_ACCOUNT, EXAMPLE_OTHER_ACCOUNT } from '../../src/examples.ts';
import { API_KEY_FIELD } from '../../src/identity.ts';
import { axonautPlugin } from '../../src/index.ts';

export { ACCOUNT };

export const KEY = 'axk-0123456789abcdef';

export const account: Resource = EXAMPLE_ACCOUNT;
export const otherAccount: Resource = EXAMPLE_OTHER_ACCOUNT;

export function ctx(
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [account],
): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { [API_KEY_FIELD]: KEY }, metadata: {} },
    fetch,
    resources,
  };
}

/** At least one realistic call per tool: the plugin's `examples`. */
export const SAMPLES: ToolSamples = axonautPlugin.examples ?? {};
