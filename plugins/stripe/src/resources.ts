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
 * The two must agree : a call on a resource whose label is not its mode is
 * refused by the classifier, so a live call is never judged as a test one.
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

/**
 * A Stripe object id : one path segment. It starts with a letter or a digit
 * and holds letters, digits, `_`, `-` and `.` only, 255 characters at most —
 * the ids Stripe issues (`cus_…`, `pi_…`, `price_…`) and the ids an account
 * chooses for its products and coupons (`SUMMER-25`, `com.example.pro`).
 *
 * The same grammar serves every identifier argument, whether it lands in the
 * request path (`id`), in the query string or the form body (`customer`,
 * `product`…) or only in a slice : no separator, no percent-escape, no query
 * or fragment delimiter, no whitespace. The leading character rules out the
 * dot segments `.` and `..`, which `encodeURIComponent` leaves untouched and
 * every URL parser then removes — `/customers/..` would be sent as `/v1/`.
 * Anything outside the grammar is refused, never escaped.
 */
export const STRIPE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/**
 * The value as a Stripe object id, or `null`. The one check `classify` and
 * `execute` share : what is classified is what is sent.
 */
export function stripeId(value: unknown): string | null {
  return typeof value === 'string' && STRIPE_ID.test(value) ? value : null;
}

/**
 * A resource ref as `discoverResources` builds it : the account id, then
 * `/test` or `/live` (a ref without the suffix carries its mode in the
 * metadata). The ref never reaches a request — the key of its mode is all it
 * selects — but it is embedded in every slice.
 */
export const STRIPE_ACCOUNT_REF = /^[A-Za-z0-9_-]{1,64}(?:\/(?:test|live))?$/;

/** The value as a Stripe resource ref, or `null`. Shared by `classify` and `execute`. */
export function stripeAccountRef(value: unknown): string | null {
  return typeof value === 'string' && STRIPE_ACCOUNT_REF.test(value) ? value : null;
}

/** Arguments that name a Stripe object ; each is embedded in a slice and sent to Stripe. */
export const ID_ARGS = ['id', 'product', 'customer', 'coupon', 'charge', 'payment_intent'] as const;
export type IdArg = (typeof ID_ARGS)[number];

/** The identifier arguments of a call : the id, or `null` when the call does not carry it. */
export type IdArgs = Readonly<Record<IdArg, string | null>>;

/**
 * Read every identifier argument of a call, for `classify` and `execute`
 * alike. An absent, `null` or empty one is `null` (the call names no member :
 * the classifier emits the glob, the executor has nothing to put in a path) ;
 * the first one that is not a `stripeId` refuses the call.
 */
export function readIdArgs(
  args: Readonly<Record<string, unknown>>,
): { readonly ids: IdArgs } | { readonly denied: string } {
  const ids: Record<IdArg, string | null> = {
    id: null,
    product: null,
    customer: null,
    coupon: null,
    charge: null,
    payment_intent: null,
  };
  for (const key of ID_ARGS) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    const id = stripeId(value);
    if (id === null) return { denied: `${key}: malformed identifier` };
    ids[key] = id;
  }
  return { ids };
}

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
 * the ref suffix, then `metadata.mode` — both set by `discoverResources`
 * from the key itself. The `env` label is never a source : it is what the
 * risk qualifier reads, and the classifier refuses a resource whose label
 * differs from the mode found here.
 */
export function modeOf(resource: Resource): StripeMode | null {
  const fromRef = REF_MODE_SUFFIX.exec(resource.ref)?.[1];
  if (isStripeMode(fromRef)) return fromRef;
  const fromMetadata = resource.metadata?.mode;
  return isStripeMode(fromMetadata) ? fromMetadata : null;
}

/** Does a pasted key belong to the mode its field claims ? (`sk_live_…`, `rk_test_…`) */
export function keyMatchesMode(key: string, mode: StripeMode): boolean {
  // nosemgrep: detect-non-literal-regexp -- mode is the closed union `test | live`
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
    const ref = stripeAccountRef(explicit);
    if (ref === null) return { denied: 'account: malformed ref' };
    const found = own.find((r) => r.ref === ref);
    return found
      ? { resource: found }
      : { denied: `account: '${ref}' is not a Stripe resource of this mission` };
  }
  if (own.length === 1) return { resource: own[0]! };
  return {
    denied:
      own.length === 0
        ? 'account: argument missing and the mission touches no Stripe resource'
        : `account: argument missing and the mission touches ${own.length} Stripe resources — name one`,
  };
}
