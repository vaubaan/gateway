/**
 * Credential declaration — how a plugin tells the host to connect a provider.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §2.4 (the executor
 *        never sees a provider credential), §7.2 (connect a provider).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 *
 * Three types, three moments :
 *   - `CredentialSpec`   : static declaration shipped by the plugin. The host
 *                          drives the flow generically from it (OAuth dance,
 *                          app installation, form, key pair) ; the plugin
 *                          writes no HTTP handler.
 *   - `CredentialSecret` : the decrypted material, in memory only, handed to
 *                          `execute`, `discoverResources` and `refresh`.
 *   - `Credential`       : the encrypted envelope the store keeps
 *                          (`@vaubaan/shared`).
 */

import type { CredentialKind } from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Form fields — shared by api-key forms, ssh-key forms and app configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface CredentialField {
  /** Key in the resulting record (`api_key`, `account_id`). */
  readonly name: string;
  readonly label: string;
  /** Secret fields are masked in the UI and never logged. */
  readonly secret: boolean;
  /** Defaults to true. */
  readonly required?: boolean;
  readonly placeholder?: string;
  /** One line shown under the field. */
  readonly help?: string;
  /** Regex source the value must match (validated by the host before any call). */
  readonly pattern?: string;
}

/** The company's registered app for a provider, as the operator configured it. */
export type ProviderAppConfig = Readonly<Record<string, string>>;

// ─────────────────────────────────────────────────────────────────────────────
// CredentialSpec — one variant per kind
// ─────────────────────────────────────────────────────────────────────────────

/** The user pastes one or more values (API token, account id). */
export interface ApiKeyCredentialSpec {
  readonly kind: 'api-key';
  readonly fields: readonly CredentialField[];
  /** URL of the provider page where the user creates the key. */
  readonly createUrl?: string;
}

export type OAuth2ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/**
 * Authorization-code flow run by the host against the company's own OAuth
 * app. The plugin never sees the client secret.
 */
export interface OAuth2CredentialSpec {
  readonly kind: 'oauth2';
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  /** RFC 7636. Always true for a public client (`clientAuthMethod: 'none'`). */
  readonly pkce: boolean;
  /**
   * RFC 8707 resource indicator sent with the authorization request and with
   * every token request (code exchange and refresh), when the provider
   * requires one.
   */
  readonly resourceIndicator?: string;
  readonly clientAuthMethod: OAuth2ClientAuthMethod;
  /**
   * Whether the token endpoint issues refresh tokens. The host performs the
   * standard `refresh_token` grant itself from `tokenUrl`, `clientAuthMethod`
   * and `resourceIndicator` ; `ProviderPlugin.refresh` overrides it for a
   * non-standard flow only.
   */
  readonly refreshable: boolean;
  /** Extra static query parameters (`access_type=offline`, `prompt=consent`). */
  readonly extraAuthorizationParams?: Readonly<Record<string, string>>;
  /** Provider-specific operator settings beyond `client_id` / `client_secret`, which the host always asks for. */
  readonly appConfigFields?: readonly CredentialField[];
}

/**
 * App-config keys of the app's OAuth client. The host asks for them for every
 * `oauth2` spec ; an `app-install` spec that declares `userVerification` must
 * list both in `appConfigFields`. The secret is used by the host only : it is
 * removed from the `appConfig` a plugin receives.
 */
export const CLIENT_ID_FIELD = 'client_id';
export const CLIENT_SECRET_FIELD = 'client_secret';

/** How the host authenticates the app's OAuth client when it verifies an installation. */
export type AppInstallClientAuthMethod = Exclude<OAuth2ClientAuthMethod, 'none'>;

/** Page-number pagination of the installations list. */
export interface AppInstallListPagination {
  /** Query parameter carrying the 1-based page number (`page`). */
  readonly pageParam: string;
  /** Query parameter carrying the page size (`per_page`). */
  readonly perPageParam: string;
  /** Page size the host asks for ; a page shorter than this is the last one. */
  readonly perPage: number;
}

/**
 * Proof that the human who came back from the installation page has access
 * to the installation the callback names. Declarative : the host runs it, the
 * plugin writes no code and never sees the client secret or the user token.
 *
 * The provider's installation page is configured to ask the installing user
 * to authorize the app (GitHub : "Request user authorization (OAuth) during
 * installation"), so the authorization request is implicit in the install
 * redirect and the callback carries an authorization code next to the
 * installation id. The host then :
 *   1. exchanges the code at `tokenUrl` with the app's `client_id` /
 *      `client_secret` for a user token ;
 *   2. lists the installations that token can reach at `installationsUrl` ;
 *   3. accepts the installation id only when it is in that list ;
 *   4. drops the user token (it is never stored and never handed to the plugin).
 *
 * A spec without this block cannot prove who performed an installation : the
 * host refuses to connect it unless the operator explicitly accepts unverified
 * installations for that provider app.
 */
export interface AppInstallUserVerification {
  /** Name of the callback query parameter carrying the authorization code (`code`). */
  readonly codeParam: string;
  /** Token endpoint the code is exchanged at (https). */
  readonly tokenUrl: string;
  readonly clientAuthMethod: AppInstallClientAuthMethod;
  /** Endpoint listing the installations the user token can reach (https, GET, Bearer). */
  readonly installationsUrl: string;
  /** Static request headers of the list call (API version, `Accept`). Never `Authorization`. */
  readonly installationsHeaders?: Readonly<Record<string, string>>;
  /**
   * Property of the JSON response holding the list (`installations`). Omit
   * when the response body is the list itself.
   */
  readonly installationsListField?: string;
  /** Property of each list item holding the installation id (`id`) — a string or a number. */
  readonly installationIdField: string;
  /** Omit when the endpoint answers the whole list in one response. */
  readonly pagination?: AppInstallListPagination;
}

/**
 * A platform app the company installs on its account (GitHub App). The host
 * redirects to the installation page and receives an installation id ; the
 * plugin mints short-lived tokens from the app's private key at call time.
 */
export interface AppInstallCredentialSpec {
  readonly kind: 'app-install';
  /**
   * Operator settings the host collects once (app id, private key, app slug…).
   * With `userVerification`, must include `client_id` and a secret `client_secret`.
   */
  readonly appConfigFields: readonly CredentialField[];
  /** Build the installation URL from the app configuration. */
  installUrl(appConfig: ProviderAppConfig): string;
  /** Name of the query parameter carrying the installation id on the callback. */
  readonly installationIdParam: string;
  /**
   * How the host binds the installation to the identity of the human who
   * performed it. Strongly recommended : without it the installation id of the
   * callback is an unauthenticated claim.
   */
  readonly userVerification?: AppInstallUserVerification;
}

/**
 * The instance generates a key pair ; the operator installs the public key
 * on the target host. The private key never leaves the instance.
 */
export interface SshKeyCredentialSpec {
  readonly kind: 'ssh-key';
  readonly algorithm: 'ed25519';
  /** Non-secret connection parameters the user fills in (host, port, user). */
  readonly fields: readonly CredentialField[];
}

export type CredentialSpec =
  | ApiKeyCredentialSpec
  | OAuth2CredentialSpec
  | AppInstallCredentialSpec
  | SshKeyCredentialSpec;

// ─────────────────────────────────────────────────────────────────────────────
// CredentialSecret — the decrypted material (memory only)
// ─────────────────────────────────────────────────────────────────────────────

interface SecretBase {
  /** Non-secret facts persisted next to the ciphertext (`team_id`, account name). */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ApiKeySecret extends SecretBase {
  readonly kind: 'api-key';
  /** Values keyed by `CredentialField.name`. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface OAuth2Secret extends SecretBase {
  readonly kind: 'oauth2';
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** ISO-8601 ; null when the provider does not say. */
  readonly expiresAt: string | null;
  readonly scopes: readonly string[];
}

export interface AppInstallSecret extends SecretBase {
  readonly kind: 'app-install';
  readonly installationId: string;
}

export interface SshKeySecret extends SecretBase {
  readonly kind: 'ssh-key';
  readonly privateKeyPem: string;
  readonly publicKey: string;
  /** Values keyed by `CredentialField.name` (host, port, user). */
  readonly fields: Readonly<Record<string, string>>;
}

export type CredentialSecret = ApiKeySecret | OAuth2Secret | AppInstallSecret | SshKeySecret;

/** Thrown when a plugin is handed a secret of another kind than its spec declares. */
export class CredentialKindMismatch extends Error {
  constructor(
    readonly pluginId: string,
    readonly expected: CredentialKind,
    readonly actual: CredentialKind,
  ) {
    super(`plugin '${pluginId}' expects a '${expected}' credential, got '${actual}'`);
    this.name = 'CredentialKindMismatch';
  }
}

/**
 * Narrow a secret to the kind a plugin declares. Plugins call this at the
 * top of `execute` / `discoverResources` instead of casting.
 */
export function expectCredentialKind<K extends CredentialKind>(
  pluginId: string,
  secret: CredentialSecret,
  kind: K,
): Extract<CredentialSecret, { kind: K }> {
  if (secret.kind !== kind) throw new CredentialKindMismatch(pluginId, kind, secret.kind);
  return secret as Extract<CredentialSecret, { kind: K }>;
}
