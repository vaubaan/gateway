/**
 * The retired keys and variables: never read, listed so the root can say they are
 * ignored, or refused (`idp.*`) by the loader.
 */
import type { EnvSource } from './secret-refs';
import { isPlainObject, type RawTree } from './tree';

/**
 * The prefix of the variables that declared an OAuth client per provider in
 * earlier versions (`VAUBAAN_PROVIDER_<ID>_<FIELD>[_FILE]`). They are no longer
 * read: the loader lists them as retired, and they are taken out of the process
 * environment with the secrets, since one of them held a client secret.
 */
export const RETIRED_PROVIDER_ENV_PREFIX = 'VAUBAAN_PROVIDER_';

/**
 * The single-provider keys of earlier builds (`idp.*`, `VAUBAAN_IDP_*`): retired, and
 * refused rather than ignored — ignoring them would leave the instance without the
 * provider people sign in with. They are written as `sign_in.idp.*` now.
 */
export const RETIRED_IDP_KEY = 'idp';
export const RETIRED_IDP_ENV_PREFIX = 'VAUBAAN_IDP_';

/** The top-level key of the retired per-provider OAuth clients (`providers.<id>.<field>`). */
export const RETIRED_PROVIDERS_KEY = 'providers';

/**
 * The top-level key of the retired authorization server of the management door
 * (`oauth.access_token_ttl`, `oauth.client_registration.policy`, …; ADR
 * platform-management-is-a-plugin-on-the-execution-door), and its variables. Not
 * `oauth_brokers`, a key of its own.
 */
export const RETIRED_MANAGEMENT_KEY = 'oauth';
export const RETIRED_MANAGEMENT_ENV = [
  'VAUBAAN_OAUTH_ACCESS_TOKEN_TTL',
  'VAUBAAN_OAUTH_REFRESH_TOKEN_TTL',
  'VAUBAAN_OAUTH_DELEGATION_MAX_LIFETIME',
  'VAUBAAN_OAUTH_REFRESH_REUSE_WINDOW_SECONDS',
  'VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY',
  'VAUBAAN_OAUTH_CLIENT_REGISTRATION_AUTO_APPROVE_LOOPBACK',
  'VAUBAAN_OAUTH_CLIENT_REGISTRATION_METADATA_DOCUMENTS',
] as const;

/**
 * The retired keys and variables a configuration still sets, sorted: every leaf
 * under the file's `providers` block, and every `VAUBAAN_PROVIDER_*` variable.
 * Never read; listed so the root can say they are ignored.
 */
export function retiredConfigKeys(tree: RawTree, env: EnvSource): string[] {
  const out = leavesUnder(tree, RETIRED_PROVIDERS_KEY);
  for (const name of Object.keys(env)) {
    if (name.startsWith(RETIRED_PROVIDER_ENV_PREFIX) && env[name] !== undefined) out.push(name);
  }
  return out.sort();
}

/**
 * The keys of the retired authorization server a configuration still sets, sorted:
 * every leaf under the file's `oauth` block, and every variable of
 * `RETIRED_MANAGEMENT_ENV`. Never read; listed so the root can say they are ignored.
 */
export function retiredManagementKeys(tree: RawTree, env: EnvSource): string[] {
  const out = leavesUnder(tree, RETIRED_MANAGEMENT_KEY);
  for (const name of RETIRED_MANAGEMENT_ENV) if (env[name] !== undefined) out.push(name);
  return out.sort();
}

/** Every leaf path under `tree[top]`, written `top.a.b`; none when the key is absent. */
function leavesUnder(tree: RawTree, top: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (isPlainObject(node) && Object.keys(node).length > 0) {
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
      return;
    }
    out.push(path);
  };
  if (tree[top] !== undefined) walk(tree[top], top);
  return out;
}
