/**
 * How a v4 secret becomes the form of a v5 plugin (ADR
 * import-from-v4-one-shot-importer D3). This is a translation table, not a
 * provider list: a provider is importable only when it is ALSO in the
 * registry of the instance (the single provider list), and every other v4
 * account is reported as "to connect by hand".
 *
 * Kept out on purpose, whatever the bundle holds: the GitHub App
 * installation (the instance registers its own App), the Railway and
 * Supabase OAuth grants (a refresh token rotated by one side breaks the
 * other). The exporter does not decrypt them and the bundle schema refuses
 * a secret for them.
 */
import type { V4Account, V4SshHost, V4StripeAccount } from './bundle';

/** v4 providers whose `provider_admins.access_token` is a key a v5 form takes as is. */
export const PASTED_KEY_PROVIDERS = ['cloudflare-dns', 'vercel'] as const;
export type PastedKeyProvider = (typeof PASTED_KEY_PROVIDERS)[number];

export const STRIPE_PROVIDER = 'stripe';
export const SSH_PROVIDER = 'ssh';

export function isPastedKeyProvider(provider: string): provider is PastedKeyProvider {
  return (PASTED_KEY_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * The `api-key` form values of a v4 account, or the reason it cannot be
 * imported. Field names are the plugins' own (a unit test holds them to the
 * plugins' credential specs).
 */
export function pastedKeyFields(
  account: V4Account,
):
  | { readonly ok: true; readonly fields: Record<string, string> }
  | { readonly ok: false; readonly reason: string } {
  if (!isPastedKeyProvider(account.provider)) {
    return { ok: false, reason: 'its secret is not imported' };
  }
  if (account.access_token === null) {
    return { ok: false, reason: 'the bundle carries no key for it' };
  }
  switch (account.provider) {
    case 'cloudflare-dns':
      return { ok: true, fields: { api_token: account.access_token } };
    case 'vercel':
      if (account.team_id === null) {
        return { ok: false, reason: 'v4 recorded no team id for it' };
      }
      return { ok: true, fields: { token: account.access_token, team_id: account.team_id } };
  }
}

/** The `api-key` form values of a Stripe account: the test key, the live key, or both. */
export function stripeKeyFields(account: V4StripeAccount): Record<string, string> {
  return {
    ...(account.test_key !== null ? { test_key: account.test_key } : {}),
    ...(account.live_key !== null ? { live_key: account.live_key } : {}),
  };
}

/** The non-secret `ssh-key` form values of a host; the key pair travels apart. */
export function sshHostFields(host: V4SshHost): Record<string, string> {
  return {
    host: host.host_address,
    port: String(host.port),
    user: host.user,
    host_key_fingerprint: host.host_key_fingerprint,
  };
}
