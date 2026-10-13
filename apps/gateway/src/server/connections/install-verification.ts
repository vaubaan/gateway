/**
 * Binding an app installation to the human who performed it (spec §6; ADR
 * connect-driver-and-resource-curation, amendment "installation binding").
 *
 * The installation id on an `app-install` callback is a claim anyone holding
 * a valid `state` can make. When the plugin's spec declares
 * `userVerification`, the provider is configured to make the installing user
 * authorize the app, and the callback carries an authorization code. The
 * host then:
 *
 *   1. exchanges the code for a user token with the app's OAuth client;
 *   2. asks the provider which installations that token can reach;
 *   3. accepts the claimed installation id only when it is in that list.
 *
 * The user token exists in this function's scope only: it is not returned,
 * not stored, not logged, and no error message carries it. Everything
 * provider-specific (endpoints, headers, response shape, pagination) comes
 * from the spec; `fetch` is injected.
 */
import type { AppInstallUserVerification } from '@vaubaan/plugin-sdk';

import { oneLine } from './errors';
import {
  exchangeUnsolicitedCode,
  OAuth2TokenError,
  TOKEN_REQUEST_TIMEOUT_MS,
  type OAuth2Client,
  type OAuth2Io,
} from './oauth2';

/** A list endpoint that does not answer within this delay is unreachable. */
export const INSTALLATIONS_REQUEST_TIMEOUT_MS = TOKEN_REQUEST_TIMEOUT_MS;
/**
 * Pages read before giving up. A user reaching more installations of one app
 * than `MAX_INSTALLATION_PAGES × perPage` is refused rather than accepted
 * unverified.
 */
export const MAX_INSTALLATION_PAGES = 20;

export type InstallationRefusalReason =
  /** The provider would not exchange the authorization code. */
  | 'authorization-code-rejected'
  /** The provider would not list installations for the user token. */
  | 'installations-list-rejected'
  /** The claimed installation is not among those the user can reach. */
  | 'installation-not-listed';

/** The provider answered and the answer does not prove the claim. */
export class InstallationRefused extends Error {
  constructor(
    readonly reason: InstallationRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'InstallationRefused';
  }
}

/** The provider could not be asked (network, 5xx, an answer that is not the declared shape). */
export class InstallationVerificationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallationVerificationUnavailable';
  }
}

export interface InstallationClaim {
  readonly installationId: string;
  /** The authorization code of the callback. */
  readonly code: string;
}

/**
 * Resolves when the provider confirms the claim; throws `InstallationRefused`
 * or `InstallationVerificationUnavailable` otherwise. Never returns the token.
 */
export async function verifyInstallation(
  verification: AppInstallUserVerification,
  client: OAuth2Client,
  claim: InstallationClaim,
  io: OAuth2Io,
): Promise<void> {
  let userToken: string;
  try {
    userToken = await exchangeUnsolicitedCode(verification, client, claim.code, io);
  } catch (err) {
    if (!(err instanceof OAuth2TokenError)) throw err;
    // GitHub answers a wrong or expired code with HTTP 200 and an `error` member
    // (`bad_verification_code`), which the generic client does not class as a dead
    // grant. Here any OAuth error the endpoint states below 5xx is its refusal.
    const answeredNo = err.oauthError !== null && err.status > 0 && err.status < 500;
    if (err.rejected || answeredNo) {
      throw new InstallationRefused('authorization-code-rejected', err.message);
    }
    throw new InstallationVerificationUnavailable(err.message);
  }

  const pagination = verification.pagination ?? null;
  const lastPage = pagination ? MAX_INSTALLATION_PAGES : 1;
  for (let page = 1; page <= lastPage; page += 1) {
    const url = new URL(verification.installationsUrl);
    if (pagination) {
      url.searchParams.set(pagination.perPageParam, String(pagination.perPage));
      url.searchParams.set(pagination.pageParam, String(page));
    }
    const ids = await listInstallationIds(verification, url, userToken, io);
    if (ids.includes(claim.installationId)) return;
    if (!pagination || ids.length < pagination.perPage) {
      throw new InstallationRefused(
        'installation-not-listed',
        'the installation is not among those the authorizing account can reach',
      );
    }
  }
  throw new InstallationRefused(
    'installation-not-listed',
    `the installation was not found in the first ${MAX_INSTALLATION_PAGES} pages of the account's installations`,
  );
}

async function listInstallationIds(
  verification: AppInstallUserVerification,
  url: URL,
  userToken: string,
  io: OAuth2Io,
): Promise<string[]> {
  let response: Response;
  try {
    response = await io.fetch(url.href, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...verification.installationsHeaders,
        Authorization: `Bearer ${userToken}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(INSTALLATIONS_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // The fetch error is about the transport; it never echoes request headers.
    const reason = err instanceof Error ? err.message : String(err);
    throw new InstallationVerificationUnavailable(
      `installations endpoint unreachable: ${oneLine(reason)}`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new InstallationRefused(
      'installations-list-rejected',
      `installations endpoint answered ${response.status}`,
    );
  }
  if (!response.ok) {
    throw new InstallationVerificationUnavailable(
      `installations endpoint answered ${response.status}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new InstallationVerificationUnavailable('installations endpoint did not answer JSON');
  }
  const field = verification.installationsListField;
  const list: unknown = field === undefined ? payload : isRecord(payload) ? payload[field] : null;
  if (!Array.isArray(list)) {
    throw new InstallationVerificationUnavailable(
      'installations endpoint did not answer the declared list',
    );
  }
  const ids: string[] = [];
  for (const item of list) {
    const id: unknown = isRecord(item) ? item[verification.installationIdField] : null;
    // An item without a usable id counts toward the page length and matches nothing.
    ids.push(typeof id === 'string' || typeof id === 'number' ? String(id) : '');
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
