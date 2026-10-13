/**
 * Stripe resources — one `Resource` per (account, mode).
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Resource", §3.1 (resources per
 *        connection) ; docs/spec/gateway-risk-model.md §4.4 (env qualification).
 *
 * A Stripe API key is pinned to one mode (`sk_test_*` / `sk_live_*`) and the
 * test and live namespaces are disjoint upstream. The connection holds up to
 * two keys (one per mode) and exposes **one resource per mode the keys
 * allow** : `acct_123/test` and `acct_123/live`. The mode is therefore :
 *   - the resource's `env` label (so `stripe[live].refund-create` resolves
 *     through the default `resourceEnvResolver`) ;
 *   - carried in the ref itself and in `metadata.mode`, so relabelling the
 *     env in the UI can never switch the API key `execute` uses.
 */

import type { Resource } from '@vaubaan/plugin-sdk';

export const STRIPE_PROVIDER = 'stripe';

export const STRIPE_MODES = ['test', 'live'] as const;
export type StripeMode = (typeof STRIPE_MODES)[number];

/** Credential field holding the key of each mode. */
export const KEY_FIELD_BY_MODE: Readonly<Record<StripeMode, string>> = {
  test: 'test_key',
  live: 'live_key',
};

/** Identifier chars a slice segment accepts ; anything else is refused rather than escaped. */
export const SAFE_IDENT = /^[a-zA-Z0-9_./~-]+$/;

const REF_MODE_SUFFIX = /\/(test|live)$/;

export function isStripeMode(value: unknown): value is StripeMode {
  return value === 'test' || value === 'live';
}

/** `acct_123` + `live` → `acct_123/live`. */
export function stripeResourceRef(accountId: string, mode: StripeMode): string {
  return `${accountId}/${mode}`;
}

/**
 * The mode a resource pins, or `null` when it cannot be determined. Order :
 * the ref suffix (set by `discoverResources`), then `metadata.mode`, then
 * the `env` label the owner put on the resource.
 */
export function modeOf(resource: Resource): StripeMode | null {
  const fromRef = REF_MODE_SUFFIX.exec(resource.ref)?.[1];
  if (isStripeMode(fromRef)) return fromRef;
  const fromMetadata = resource.metadata?.mode;
  if (isStripeMode(fromMetadata)) return fromMetadata;
  return isStripeMode(resource.env) ? resource.env : null;
}

/** Does a pasted key belong to the mode its field claims ? (`sk_live_…`, `rk_test_…`) */
export function keyMatchesMode(key: string, mode: StripeMode): boolean {
  return new RegExp(`^(sk|rk)_${mode}_[A-Za-z0-9]+$`).test(key);
}

export type ResolvedResource = { readonly resource: Resource } | { readonly denied: string };

/**
 * Which Stripe resource a call targets : the explicit `account` argument
 * (a ref listed in the mission), else the mission's single Stripe resource.
 * Anything else is refused — never mapped to a broad slice.
 */
export function resolveStripeResource(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ResolvedResource {
  const own = resources.filter((r) => r.provider === STRIPE_PROVIDER);
  const explicit = args.account;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !SAFE_IDENT.test(explicit)) {
      return { denied: 'account: malformed ref' };
    }
    const found = own.find((r) => r.ref === explicit);
    return found
      ? { resource: found }
      : { denied: `account: '${explicit}' is not a Stripe resource of this mission` };
  }
  if (own.length === 1) return { resource: own[0]! };
  return {
    denied:
      own.length === 0
        ? 'account: argument missing and the mission touches no Stripe resource'
        : `account: argument missing and the mission touches ${own.length} Stripe resources — name one`,
  };
}
