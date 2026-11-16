/**
 * Shared fixtures of the github plugin tests : a fine-grained token, mission
 * resources and a context builder. No network : every context carries a
 * `mockFetch`.
 */
import type { AccountContext, ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch } from '@vaubaan/plugin-sdk/testing';

/** A fine-grained token of the shape the field accepts ; it opens nothing. */
export const PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';

/** An account made before the form named its repository (2026-11-16): the token alone. */
export const tokenCredential = { kind: 'api-key', fields: { token: PAT }, metadata: {} } as const;

/** An account of today: the token and its one repository. */
export const repoCredential = {
  kind: 'api-key',
  fields: { token: PAT, repository: 'acme/app' },
  metadata: {},
} as const;

export const appRepo: Resource = {
  service: 'github',
  ref: 'acme/app',
  displayName: 'acme/app',
};
export const libRepo: Resource = {
  service: 'github',
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
