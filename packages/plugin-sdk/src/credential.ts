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
  /**
   * How the provider withdraws the grant when a connection is revoked (spec
   * vaubaan-gateway §2.3). Declarative : the host sends the request, because
   * it may carry the app's client secret, which a plugin never sees. Absent
   * when the provider documents no such endpoint : the person removes the
   * grant by hand (`ProviderPlugin.manualRevocation`).
   */
  readonly revocation?: OAuth2Revocation;
}

/**
 * The request that withdraws an OAuth grant at the provider. Two shapes, each
 * the one a shipped provider documents :
 *
 *   `token-form`               `POST url`, form-encoded `token=<the refresh
 *                              token, or the access token when no refresh
 *                              token is stored>`. No client authentication.
 *                              (Google : revoking either token revokes both.)
 *   `client-credentials-json`  `POST url`, JSON `{ client_id, client_secret,
 *                              refresh_token }`. Needs a stored refresh token.
 *                              (Supabase Management API.)
 *
 * Any 2xx answer means the provider took the request ; anything else, and a
 * provider that does not answer, means the grant may still stand.
 */
export interface OAuth2Revocation {
  /** The revocation endpoint (https). */
  readonly url: string;
  readonly format: OAuth2RevocationFormat;
}

export const OAUTH2_REVOCATION_FORMATS = ['token-form', 'client-credentials-json'] as const;
export type OAuth2RevocationFormat = (typeof OAUTH2_REVOCATION_FORMATS)[number];

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

// ─────────────────────────────────────────────────────────────────────────────
// Creating the company's app from a manifest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One access level of a provider permission (`read`, `write`), and the tools
 * that need at least this level. Levels are listed lowest first ; a higher
 * level includes the lower ones.
 */
export interface AppPermissionLevel {
  /** The provider's word for the level, sent as is (`read`, `write`). */
  readonly access: string;
  /** What a person reads (`Read`, `Read and write`). */
  readonly label: string;
  /** Tools of this plugin that need at least this level ; may be empty. */
  readonly tools: readonly string[];
  /**
   * The tools among `tools` that need this level for some calls only, each
   * with the words that say which (`for a file under .github/workflows/`).
   * The plugin checks such a need itself, call by call.
   */
  readonly onlyWhen?: Readonly<Record<string, string>>;
}

/**
 * One permission the company app may request, as the provider names it. The
 * single declaration the host derives the choice of permissions, the manifest
 * and the "tools that stop working" sentences from.
 */
export interface AppPermission {
  /** The provider's key (`contents`, `pull_requests`). */
  readonly name: string;
  readonly label: string;
  /** One sentence : what the permission lets the app do. */
  readonly description: string;
  /** Lowest first ; at least one. */
  readonly levels: readonly AppPermissionLevel[];
  /** The provider grants it at its lowest level whatever is asked (GitHub's metadata). */
  readonly mandatory?: boolean;
  /**
   * Set on a permission whose highest level a company may prefer to withhold :
   * why it is sensitive, in one or two sentences. Shown next to the choice.
   */
  readonly sensitive?: string;
}

/** Who owns the app at the provider : an organisation (its login) or the administrator's own account. */
export type AppOwner =
  | { readonly kind: 'organization'; readonly login: string }
  | { readonly kind: 'personal' };

/** What the host hands `buildManifest` : addresses on `public_url`, the chosen permissions. */
export interface AppManifestInput {
  readonly name: string;
  /** The instance's public URL (the app's homepage). */
  readonly homepageUrl: string;
  /** The connection callback of this provider (`/connections/callback/<id>`). */
  readonly callbackUrl: string;
  /** Where the provider sends the browser back after the app is created. */
  readonly redirectUrl: string;
  /** Permission name → access, the mandatory ones included. */
  readonly permissions: Readonly<Record<string, string>>;
}

/** The app the provider created, read from its answer to the code exchange. */
export interface RegisteredApp {
  /** Every app-config field (`appConfigFields`), secrets included. */
  readonly appConfig: ProviderAppConfig;
  readonly name: string;
  readonly slug: string;
  readonly ownerLogin: string;
  /** The app's page at the provider (https). */
  readonly htmlUrl: string;
  /** The permissions the app holds, as the provider answered them. */
  readonly permissions: Readonly<Record<string, string>>;
}

/**
 * The company's app created from a manifest (GitHub App manifest flow) : the
 * administrator picks the owner, a name and the permissions ; the host posts
 * the manifest to `registrationUrl` with a single-use `state` ; the provider
 * asks the administrator to confirm and sends the browser back to
 * `redirectUrl` with a code ; the host exchanges the code, server to server,
 * at `conversionUrl(code)`. Declarative like `userVerification` : the host
 * runs the flow and stores the settings where the manual form would ; the
 * plugin writes no handler.
 */
export interface AppManifestRegistration {
  /** The permissions the app may request ; the default is every highest level. */
  readonly permissions: readonly AppPermission[];
  /** Regex source an organisation login must match before it is put in a URL. */
  readonly ownerLoginPattern: string;
  /** Longest name the provider accepts. */
  readonly nameMaxLength: number;
  /** The address the manifest is posted to (the host appends `stateParam`). */
  registrationUrl(owner: AppOwner): string;
  /** The form field carrying the JSON manifest (`manifest`). */
  readonly manifestField: string;
  /** The query parameter carrying the state, out and back (`state`). */
  readonly stateParam: string;
  /** The query parameter of the redirect carrying the code (`code`). */
  readonly codeParam: string;
  buildManifest(input: AppManifestInput): Readonly<Record<string, unknown>>;
  /** The exchange endpoint for this code (POST, no authentication), or `null` for a malformed code. */
  conversionUrl(code: string): string | null;
  /** Static headers of the exchange (API version, `Accept`). Never `Authorization`. */
  readonly conversionHeaders?: Readonly<Record<string, string>>;
  /** The created app, or `null` when the answer lacks a field the instance needs. */
  registeredApp(body: unknown): RegisteredApp | null;
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
  /**
   * How the administrator creates the app from the interface, when the
   * provider offers a manifest flow. Without it the app is entered by hand.
   */
  readonly manifestRegistration?: AppManifestRegistration;
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
