/**
 * Credential of the `stripe` provider : the secret key of the test mode, of
 * the live mode, or both, pasted by hand (`api-key`).
 *
 * ADR : one-place-to-authorize-services-token-first (amended 2026-10-31 :
 *       grant wide at the service, the mission narrows).
 *
 * Read through Context7 on 2026-10-31 (Stripe docs, "API keys", "Restricted
 * API keys", the permissions reference) : every account has a secret key per
 * sandbox and in live mode, on Developers, API keys ; a live secret key that
 * Stripe created can be revealed again, one created by hand only once. A
 * restricted key holds None, Read or Write per resource, and Stripe refuses
 * what it lacks call by call. The guide asks for the secret key : the gateway
 * holds live refunds, payouts and prices behind their own permissions.
 * Stripe keys carry no expiry in what the API answers.
 */

import type { ApiKeyCredentialSpec, ConnectionContext, CredentialCheck } from '@vaubaan/plugin-sdk';

import { stripeAccounts, type StripeAccount } from './execute.ts';

/** Where a person reveals, rolls and deletes the keys of the account. */
export const STRIPE_KEYS_PAGE = 'https://dashboard.stripe.com/apikeys';

export const stripeCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'secret key',
  createUrl: STRIPE_KEYS_PAGE,
  fields: [
    {
      name: 'test_key',
      label: 'Test-mode secret key',
      secret: true,
      required: false,
      placeholder: 'sk_test_…',
      pattern: '^(sk|rk)_test_[A-Za-z0-9]+$',
      help: 'The secret key of the sandbox. Leave empty for a live-only account.',
    },
    {
      name: 'live_key',
      label: 'Live-mode secret key',
      secret: true,
      required: false,
      placeholder: 'sk_live_…',
      pattern: '^(sk|rk)_live_[A-Za-z0-9]+$',
      help: 'The secret key of the live account (real money). Leave empty for a test-only account.',
    },
  ],
  guide: {
    steps: [
      { do: 'Sign in to the Stripe Dashboard of the account the agents will work on.' },
      {
        do: 'Open the page and, in the sandbox, reveal the Secret key (sk_test_…) and copy it.',
        path: ['Developers', 'API keys'],
        url: STRIPE_KEYS_PAGE,
      },
      {
        do: 'Switch to live mode and reveal the Secret key (sk_live_…), or create one: Stripe shows a key you create once.',
        path: ['Standard keys', 'Reveal live key'],
      },
      { do: 'Paste the test key, the live key, or both, here.' },
    ],
    reach: {
      what: 'Key type',
      grant: 'The secret key, which opens the whole account, not a restricted key',
      why: 'A restricted key fails tool by tool on what it lacks; this gateway holds live refunds, payouts and prices behind their own permissions, and a mission reaches only the modes and permissions it names.',
    },
    // A secret key has no permission choice.
    permissions: [],
    expiry: {
      kind: 'none',
      reason:
        'Stripe keys do not expire: roll or delete the key on the API keys page to end this account.',
    },
    docsUrl: 'https://docs.stripe.com/keys',
  },
  verify: verifyStripeKeys,
};

/** The account each key opens, named once with its modes: `Acme Inc (test, live)`. */
export async function verifyStripeKeys(ctx: ConnectionContext): Promise<CredentialCheck> {
  return { account: accountWords(await stripeAccounts(ctx)), expiresAt: null };
}

function accountWords(accounts: readonly StripeAccount[]): string {
  const modesByLabel = new Map<string, string[]>();
  for (const { label, mode } of accounts) {
    modesByLabel.set(label, [...(modesByLabel.get(label) ?? []), mode]);
  }
  return [...modesByLabel].map(([label, modes]) => `${label} (${modes.join(', ')})`).join(', ');
}
