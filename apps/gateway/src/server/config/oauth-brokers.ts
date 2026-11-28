/**
 * The pure rules of the `oauth_brokers.<name>.*` keys (ADR
 * google-calendar-through-an-oauth-broker D1): the OAuth brokers the instance is
 * enrolled with, and which broker serves which broker provider.
 *
 * A broker is a name, a base URL and a key (a secret). It serves the broker
 * providers its `providers` list names (`google`); a broker without a list is
 * the instance's default broker and serves every provider no other broker
 * lists. At most one default broker, and a provider is listed by one broker at
 * most: the broker of a plugin is never ambiguous (`brokerFor`). A broker is
 * attested unless its block says `attestation: none` (ADR
 * oauth-broker-stateless-in-an-attested-enclave D4); nothing in the
 * configuration widens the allowlist of broker versions the release admits.
 *
 * Handbook: docs/handbook/configuration.md ("OAuth brokers"),
 * docs/handbook/oauth-broker-contract.md.
 */
import type { BrokerAttestationMode, OAuthBrokerConfig } from './types';

/** A broker name: a lower-case letter, then letters, digits or hyphens (32 at most). */
const BROKER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A broker provider, as a plugin names it (`OAuth2Broker.provider` of the SDK). */
const BROKER_PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const OAUTH_BROKER_PROBLEMS = {
  name: 'a broker name is a lower-case letter, then letters, digits or hyphens (at most 32)',
  url: 'is not a valid URL',
  scheme: 'must use https (http is accepted for a loopback host only: localhost, 127.0.0.1, ::1)',
  shape: 'must carry no user, password, query or fragment',
  provider: 'a broker provider is a lower-case letter, then letters, digits or hyphens',
  defaultTwice: 'at most one broker may leave providers unset (the default broker)',
  attestation: 'must be required or none',
  attestedOverHttp:
    'an attested broker is reached over https only; http (a loopback host) needs attestation: none',
} as const;

export const BROKER_ATTESTATION_MODES: readonly BrokerAttestationMode[] = ['required', 'none'];

/** `attestation`, as written (trimmed, lower-cased); `null` when it is not one of the modes. */
export function parseBrokerAttestation(raw: string | undefined): BrokerAttestationMode | null {
  if (raw === undefined) return 'required';
  const mode = raw.trim().toLowerCase();
  return (BROKER_ATTESTATION_MODES as readonly string[]).includes(mode)
    ? (mode as BrokerAttestationMode)
    : null;
}

export function isBrokerName(raw: string): boolean {
  return BROKER_NAME.test(raw);
}

export function isBrokerProvider(raw: string): boolean {
  return BROKER_PROVIDER.test(raw);
}

export type BrokerUrl =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly problem: string };

/**
 * The base URL of a broker: https (http for a loopback host only, the tests),
 * no credentials, no query, no fragment. A path is a prefix of the four calls;
 * its trailing slashes are dropped.
 */
export function parseBrokerUrl(raw: string): BrokerUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // expected: the configured broker URL is not a URL: said as a problem
    return { ok: false, problem: OAUTH_BROKER_PROBLEMS.url };
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, problem: OAUTH_BROKER_PROBLEMS.scheme };
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return { ok: false, problem: OAUTH_BROKER_PROBLEMS.shape };
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { ok: true, url };
}

/** A problem across the brokers: the path to report it under, and the sentence. */
export interface BrokerSetProblem {
  readonly path: string;
  readonly message: string;
}

/** Two default brokers, or one provider listed by two brokers. */
export function brokerSetProblems(brokers: readonly OAuthBrokerConfig[]): BrokerSetProblem[] {
  const problems: BrokerSetProblem[] = [];
  const defaults = brokers.filter((b) => b.providers.length === 0);
  for (const extra of defaults.slice(1)) {
    problems.push({
      path: `oauth_brokers.${extra.name}.providers`,
      message: OAUTH_BROKER_PROBLEMS.defaultTwice,
    });
  }
  const claimedBy = new Map<string, string>();
  for (const broker of brokers) {
    for (const provider of broker.providers) {
      const other = claimedBy.get(provider);
      if (other !== undefined) {
        problems.push({
          path: `oauth_brokers.${broker.name}.providers`,
          message: `provider "${provider}" is already served by broker "${other}"`,
        });
        continue;
      }
      claimedBy.set(provider, broker.name);
    }
  }
  return problems;
}

/**
 * The broker that serves a broker provider: the one whose `providers` lists
 * it, else the default broker (no `providers`), else `null`.
 */
export function brokerFor(
  brokers: readonly OAuthBrokerConfig[],
  provider: string,
): OAuthBrokerConfig | null {
  return (
    brokers.find((b) => b.providers.includes(provider)) ??
    brokers.find((b) => b.providers.length === 0) ??
    null
  );
}
