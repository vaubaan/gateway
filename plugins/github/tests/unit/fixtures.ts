/**
 * Shared fixtures of the github plugin tests : a fine-grained token, mission
 * resources and a context builder. No network : every context carries a
 * `mockFetch`.
 */
import type { AccountContext, ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch } from '@vaubaan/plugin-sdk/testing';

/** A fine-grained token of the shape the field accepts ; it opens nothing. */
export const PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';

export const tokenCredential = { kind: 'api-key', fields: { token: PAT }, metadata: {} } as const;

export const appRepo: Resource = {
  provider: 'github',
  ref: 'acme/app',
  displayName: 'acme/app',
};
export const libRepo: Resource = {
  provider: 'github',
  ref: 'acme/lib',
  displayName: 'acme/lib',
};

export function accountCtx(
  fetch: MockFetch,
  overrides: Partial<AccountContext> = {},
): AccountContext {
  return { credential: tokenCredential, fetch, ...overrides };
}

export function executeCtx(
  fetch: MockFetch,
  resources: readonly Resource[] = [appRepo],
  overrides: Partial<ExecuteContext> = {},
): ExecuteContext {
  return { ...accountCtx(fetch), resources, ...overrides };
}
