/**
 * Credential declaration — how a plugin tells the host to connect a provider.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §2.4 (the executor
 *        never sees a provider credential), §7.2 (connect a provider).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 *
 * Three types, three moments :
 *   - `CredentialSpec`   : static declaration shipped by the plugin, one way
 *                          of connecting per plugin (ADR
 *                          one-place-to-authorize-services-token-first). The
 *                          host drives the flow generically from it (form,
 *                          OAuth dance, key pair) ; the plugin writes no HTTP
 *                          handler.
 *   - `CredentialSecret` : the decrypted material, in memory only, handed to
 *                          `execute`, `discoverResources` and `refresh`.
 *   - `Credential`       : the encrypted envelope the store keeps
 *                          (`@vaubaan/shared`).
 */

import type { CredentialKind } from '@vaubaan/shared';

import type { ConnectionContext } from './plugin.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Form fields — shared by api-key forms, ssh-key forms and OAuth client configuration
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

/** The company's OAuth client for a provider, as the operator configured it (`oauth2` only). */
export type ProviderAppConfig = Readonly<Record<string, string>>;

// ─────────────────────────────────────────────────────────────────────────────
// CredentialSpec — one variant per kind
// ─────────────────────────────────────────────────────────────────────────────

/** Access a token permission grants at the provider, in the provider's own two words. */
export const TOKEN_PERMISSION_ACCESS = ['read', 'read-write'] as const;
export type TokenPermissionAccess = (typeof TOKEN_PERMISSION_ACCESS)[number];

/**
 * One permission (GitHub "Contents", Supabase "Database") the person ticks
 * when they create the token, with the tools of the plugin it serves. The
 * connect page lists these; nothing about permissions is written in the page.
 */
export interface TokenPermission {
  /** The permission's name as the provider's token page shows it. */
  readonly name: string;
  readonly access: TokenPermissionAccess;
  /** Tools of the plugin that need it ; at least one. */
  readonly tools: readonly string[];
}

/**
 * How a person creates the token by hand at the provider: the guide the
 * connect page shows, derived from this declaration.
 */
export interface TokenGuide {
  /** Where to click at the provider, one plain sentence per step, no markup. */
  readonly steps: readonly string[];
  /**
   * The permissions to grant. Every tool of the plugin that this way of
   * connecting can run is served by at least one of them (`definePlugin`).
   * Empty when the provider's token carries no permission choice (the steps
   * then say so).
   */
  readonly permissions: readonly TokenPermission[];
  /** The lifetime to choose at the provider, in days ; `null` when the provider offers no expiry. */
  readonly recommendedExpiryDays: number | null;
  /** The provider's documentation of this kind of token. */
  readonly docsUrl?: string;
}

/**
 * What the provider says about a pasted credential, read by `verify` before
 * anything is stored: who it belongs to and when it stops working.
 */
export interface CredentialCheck {
  /** The account the credential acts as, in the provider's words (`octocat`, `acme, beta`) ; `null` when not exposed. */
  readonly account: string | null;
  /** ISO-8601 ; `null` when the credential does not expire or the provider does not say. */
  readonly expiresAt: string | null;
}

/** The user pastes one or more values (API token, account id). */
export interface ApiKeyCredentialSpec {
  readonly kind: 'api-key';
  readonly fields: readonly CredentialField[];
  /** URL of the provider page where the user creates the key. */
  readonly createUrl?: string;
  /**
   * What the person creates, in the provider's words, lower case
   * ("fine-grained personal access token"). Shown on the connect page.
   */
  readonly label?: string;
  /** How to create it by hand ; the connect page renders it. */
  readonly guide?: TokenGuide;
  /**
   * Ask the provider about the pasted values before anything is stored. A
   * rejection throws `UpstreamAuthError` (nothing is stored, the person reads
   * the provider's message) ; an expiry in the past is refused by the host.
   * Absent: the first resource discovery is the only check.
   */
  verify?(ctx: ConnectionContext): Promise<CredentialCheck>;
}

export type OAuth2ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/**
 * Authorization-code flow run by the host. The OAuth client is either the
 * company's own, declared once by an administrator (`appConfigFields`, Gmail),
 * or one the gateway registers itself at the provider (`clientRegistration`,
 * Miro's MCP server). The plugin never sees the client secret.
 */
export interface OAuth2CredentialSpec {
  readonly kind: 'oauth2';
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  /**
   * The provider lets a client register itself (RFC 7591 dynamic client
   * registration): the host registers this instance as a client the first
   * time someone connects, keeps the client (its secret sealed in the
   * instance settings), reuses it for every connection of the instance, and
   * registers again when the provider rejects it or the instance's callback
   * address changed. Nobody declares anything: no administrator step, no
   * secret to paste. Absent: an administrator declares the company's client
   * (`client_id`, `client_secret`, `appConfigFields`). ADR
   * oauth-client-registered-by-the-gateway.
   */
  readonly clientRegistration?: OAuth2ClientRegistration;
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
  /**
   * Provider-specific operator settings beyond `client_id` / `client_secret`,
   * which the host asks for whenever the client is declared by an
   * administrator. Not allowed with `clientRegistration`: nobody declares
   * anything then.
   */
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
 * How the host registers its own OAuth client at a provider that accepts
 * dynamic client registration (RFC 7591). The registration asks for the
 * authorization-code and refresh-token grants, the spec's `scopes`, the
 * instance's callback as the only redirect URI, and `clientAuthMethod` as the
 * token endpoint authentication method.
 */
export interface OAuth2ClientRegistration {
  /** The registration endpoint (https), as the provider's authorization server metadata names it. */
  readonly registrationUrl: string;
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
 * App-config keys of the OAuth client. The host asks for them for every
 * `oauth2` spec. The secret is used by the host only : it is removed from the
 * `appConfig` a plugin receives.
 */
export const CLIENT_ID_FIELD = 'client_id';
export const CLIENT_SECRET_FIELD = 'client_secret';

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

export type CredentialSpec = ApiKeyCredentialSpec | OAuth2CredentialSpec | SshKeyCredentialSpec;

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

export interface SshKeySecret extends SecretBase {
  readonly kind: 'ssh-key';
  readonly privateKeyPem: string;
  readonly publicKey: string;
  /** Values keyed by `CredentialField.name` (host, port, user). */
  readonly fields: Readonly<Record<string, string>>;
}

export type CredentialSecret = ApiKeySecret | OAuth2Secret | SshKeySecret;

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
