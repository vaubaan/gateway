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
// Form fields — shared by api-key and ssh-key forms
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
 * One thing the person does at the provider, in the imperative ("Open the
 * page and start a new fine-grained token."). One plain sentence, no markup:
 * the menus to follow go in `path`, a command to type in `code`, a page to
 * open in `url`, a picture of the hard screen in `screenshot`; the connect
 * page renders them as highlighted path chips, a copyable block, a link and a
 * figure with its provenance (ADR plugin-contract-and-credential-spec,
 * amendment 2026-11-13). The sentence never carries the path.
 */
export interface GuideStep {
  readonly do: string;
  /**
   * The application path the person follows at the provider, in the
   * provider's own menu labels: `['Settings', 'Developer settings', 'Personal
   * access tokens']`. 1 to `GUIDE_PATH_MAX_SEGMENTS` segments of at most
   * `GUIDE_PATH_SEGMENT_MAX_LENGTH` characters each.
   */
  readonly path?: readonly string[];
  /** The provider page this step happens on (https). */
  readonly url?: string;
  /** A command or a value to type, shown as code the person can copy. */
  readonly code?: string;
  /** The file name of a screenshot declared in the guide's `screenshots` (`token-form.webp`). */
  readonly screenshot?: string;
}

/** At most this many segments in a step's `path`. */
export const GUIDE_PATH_MAX_SEGMENTS = 8;

/** At most this many characters in one segment of a step's `path`. */
export const GUIDE_PATH_SEGMENT_MAX_LENGTH = 40;

/**
 * The folder of a plugin, beside its `package.json`, that holds the files its
 * guide's `screenshots` declare. Fixed, like `risk-catalog.yaml`: the host
 * serves them from there and the bundle script copies it beside `index.js`.
 */
export const GUIDE_SCREENSHOT_DIR = 'docs/connect';

/** A screenshot's file name: a lowercase slug, `.png` or `.webp`. */
export const GUIDE_SCREENSHOT_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.(png|webp)$/;

/**
 * The licences a screenshot may ship under: each allows redistribution with
 * attribution. `ours` is a capture the Vaubaan team took itself. A
 * NonCommercial or NoDerivatives licence never ships.
 */
export const SCREENSHOT_LICENCES = ['CC-BY-4.0', 'MIT', 'Apache-2.0', 'ours'] as const;
export type ScreenshotLicence = (typeof SCREENSHOT_LICENCES)[number];

/** When a screenshot was taken: `YYYY-MM`. */
export const SCREENSHOT_TAKEN_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Upper bound of a screenshot's `alt` text. */
export const SCREENSHOT_ALT_MAX_LENGTH = 200;

/**
 * Where a screenshot comes from, declared beside the guide: the page it was
 * taken from and under which licence, or `ours`. The words under the image
 * are derived from it (`screenshotAttribution`), never written.
 */
export interface Screenshot {
  /** The https URL of the documentation page the image illustrates, or `'ours'`. */
  readonly source: string;
  readonly licence: ScreenshotLicence;
  /** `YYYY-MM`: when it was taken, so that a stale one can be found. */
  readonly taken: string;
  /** What the image shows, for a person who cannot see it (1 to 200 characters). */
  readonly alt: string;
}

/** The licence as people read it: `CC BY 4.0`, `MIT`, `Apache 2.0`. */
const LICENCE_WORDS: Readonly<Record<Exclude<ScreenshotLicence, 'ours'>, string>> = {
  'CC-BY-4.0': 'CC BY 4.0',
  MIT: 'MIT',
  'Apache-2.0': 'Apache 2.0',
};

/**
 * The line under a screenshot, the same on the site and on the gateway:
 * "Taken by the Vaubaan team, 2026-11" for a capture of ours, else
 * "<service> docs, 2026-11 · from docs.github.com (CC BY 4.0)".
 */
export function screenshotAttribution(service: string, screenshot: Screenshot): string {
  if (screenshot.source === 'ours' || screenshot.licence === 'ours') {
    return `Taken by the Vaubaan team, ${screenshot.taken}`;
  }
  return `${service} docs, ${screenshot.taken} · from ${screenshotSourceHost(screenshot)} (${screenshotLicenceWords(screenshot.licence)})`;
}

/** A licence as people read it ("CC BY 4.0"); `ours` reads "taken by the Vaubaan team". */
export function screenshotLicenceWords(licence: ScreenshotLicence): string {
  return licence === 'ours' ? 'taken by the Vaubaan team' : LICENCE_WORDS[licence];
}

/** The host of a screenshot's source (`docs.github.com`), or `null` for one of ours. */
export function screenshotSourceHost(screenshot: Pick<Screenshot, 'source'>): string | null {
  if (screenshot.source === 'ours') return null;
  try {
    return new URL(screenshot.source).host;
  } catch {
    return null;
  }
}

/**
 * How wide the grant is at the provider (ADR
 * one-place-to-authorize-services-token-first, amendment 2026-10-31): the
 * person grants the widest the provider offers for what this account
 * connects, once, and each mission narrows it — except where the token picks
 * the resources it reaches (amendment 2026-11-13: GitHub asks for the
 * repositories the missions will use). The connect page shows it above the
 * steps.
 */
export interface TokenReach {
  /** What the token reaches, in the provider's words: "Repository access", "Zone Resources". */
  readonly what: string;
  /** What to pick there: "All zones", "Full access", "Only select repositories: the ones the missions will use". */
  readonly grant: string;
  /** Why wide is safe and saves a second visit: one sentence, the gateway's argument. */
  readonly why: string;
}

/**
 * Who knows when the token stops working:
 *
 *   `provider-reports` `verify` reads the expiry from the provider, so the
 *                      account page shows the date and warns before it;
 *   `person-types`     the person picks a lifetime at the provider, which the
 *                      gateway cannot read back: the page says so;
 *   `none`             the provider's tokens do not expire; `reason` says how
 *                      the person ends one.
 */
export type TokenExpiry =
  | { readonly kind: 'provider-reports' }
  | { readonly kind: 'person-types'; readonly recommendedDays: number }
  | { readonly kind: 'none'; readonly reason: string };

export const TOKEN_EXPIRY_KINDS = ['provider-reports', 'person-types', 'none'] as const;
export type TokenExpiryKind = TokenExpiry['kind'];

/**
 * How a person creates the token by hand at the provider: the guide the
 * connect page shows, derived from this declaration. Required of every
 * `api-key` way: the instructions are part of the plugin contract.
 */
export interface TokenGuide {
  /** Where to click at the provider, in order, ending with the copy. */
  readonly steps: readonly GuideStep[];
  /** How wide to grant, and why wide. */
  readonly reach: TokenReach;
  /**
   * The permissions to grant. Every tool of the plugin that this way of
   * connecting can run is served by at least one of them (`definePlugin`).
   * Empty when the provider's token carries no permission choice (`reach`
   * then says what it opens).
   */
  readonly permissions: readonly TokenPermission[];
  readonly expiry: TokenExpiry;
  /** The provider's documentation of this kind of token (https). */
  readonly docsUrl: string;
  /**
   * The screenshots the steps name, by file name, each with its provenance.
   * The files live in `GUIDE_SCREENSHOT_DIR` of the plugin folder; every one
   * declared is named by exactly one step. One, on the hard screen of the
   * service, is the rule; absent when the sentences are enough.
   */
  readonly screenshots?: Readonly<Record<string, Screenshot>>;
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
  /**
   * The permission names (`TokenPermission.name`) the provider confirmed the
   * token holds, for a plugin that can read them; absent when it cannot.
   */
  readonly granted?: readonly string[];
}

/**
 * One of several shapes the same key can take at the provider (Vercel: a token
 * scoped to a team, or to one project of it). The connect page shows the
 * alternatives as a radio before the guide's steps; the person picks one, and
 * the host asks and keeps only the fields shared by every alternative plus
 * the chosen one's. The choice itself is not stored: the plugin reads which
 * field is there (ADR plugin-contract-and-credential-spec, amendment
 * 2026-11-11).
 */
export interface CredentialAlternative {
  /** A lowercase slug (`team`, `project`): what the form sends. */
  readonly id: string;
  /** What the radio says, in a few words ("Team", "One project"). */
  readonly label: string;
  /** One sentence under the radio: when to choose it. */
  readonly help?: string;
  /**
   * Names of the spec's `fields` only this alternative asks for ; at least
   * one, each in one alternative at most. A field no alternative names is
   * asked whatever the choice (the token).
   */
  readonly fields: readonly string[];
  /** What to do at the provider for this alternative, shown before the guide's own steps. */
  readonly steps: readonly GuideStep[];
}

/** At most this many alternatives per spec: a radio a person reads at a glance. */
export const CREDENTIAL_ALTERNATIVES_MAX = 4;

/** An alternative's id: a lowercase slug, at most 32 characters. */
export const CREDENTIAL_ALTERNATIVE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The user pastes one or more values (API token, account id). */
export interface ApiKeyCredentialSpec {
  readonly kind: 'api-key';
  readonly fields: readonly CredentialField[];
  /**
   * Two to `CREDENTIAL_ALTERNATIVES_MAX` shapes of the key, one chosen at
   * connect ; absent when the key has one shape.
   */
  readonly alternatives?: readonly CredentialAlternative[];
  /** URL of the provider page where the user creates the key: the token page itself, not a dashboard. */
  readonly createUrl: string;
  /**
   * What the person creates, in the provider's words, lower case
   * ("fine-grained personal access token"). Shown on the connect page.
   */
  readonly label: string;
  /** How to create it by hand ; the connect page renders it. */
  readonly guide: TokenGuide;
  /**
   * Ask the provider about the pasted values before anything is stored. A
   * cause the plugin can name throws `CredentialRefusal` with its own
   * sentence ; a rejection otherwise throws `UpstreamAuthError` (nothing is
   * stored) ; an expiry in the past is refused by the host.
   */
  verify(ctx: ConnectionContext): Promise<CredentialCheck>;
}

export type OAuth2ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/**
 * Authorization-code flow for a provider that offers no key a person can
 * make. The spec declares exactly one source for the OAuth client (ADR
 * google-calendar-through-an-oauth-broker D3):
 *
 *   - `OAuth2RegisteredClientSpec` — the gateway registers its own client at
 *     the provider (`clientRegistration`, RFC 7591; Miro's MCP server) and
 *     runs the flow against the provider's endpoints;
 *   - `OAuth2BrokeredSpec` — the client is an OAuth broker's (`broker`): the
 *     broker the instance is enrolled with runs the flow with its own client;
 *     it keeps no token (Google Calendar).
 *
 * No administrator declares a client (ADR gmail-over-imap-with-an-app-password).
 * Either way the plugin receives an access token (`OAuth2Secret`) and never
 * sees a client secret, a refresh token of a broker or a broker key.
 */
export type OAuth2CredentialSpec = OAuth2RegisteredClientSpec | OAuth2BrokeredSpec;

/**
 * The OAuth client is an OAuth broker's (ADRs google-calendar-through-an-oauth-broker
 * D1, D2 and oauth-broker-stateless-in-an-attested-enclave D1): a service
 * outside the gateway that owns a client at the provider and runs the
 * authorization-code flow for the instances enrolled with it. The host asks
 * the broker for the flow, redeems the one-time grant the browser brings
 * back, and keeps the provider's refresh token sealed beside the access
 * token, host only; it refreshes and revokes through the broker, which adds
 * its client secret and keeps no token. The plugin receives the access token
 * alone. A plugin whose broker is not configured is listed as not configured.
 *
 * The provider's endpoints, PKCE towards the provider, the client
 * authentication and the revocation are the broker's: they are not declared.
 */
export interface OAuth2BrokeredSpec {
  readonly kind: 'oauth2';
  readonly broker: OAuth2Broker;
  /** Never set on this variant: one client source per spec. */
  readonly clientRegistration?: never;
  /** The scopes the broker asks the provider for: the narrowest the tools need. */
  readonly scopes: readonly string[];
}

/** Which provider a broker runs the flow at, in the broker's words (`google`). */
export interface OAuth2Broker {
  /** A lowercase slug (`google`): what the gateway names as `provider` in `POST /flows`. */
  readonly provider: string;
}

/** Whether an `oauth2` spec takes its client from a broker. */
export function isBrokeredSpec(spec: OAuth2CredentialSpec): spec is OAuth2BrokeredSpec {
  return spec.broker !== undefined;
}

/** A broker provider name: a lowercase slug, at most 32 characters. */
export const BROKER_PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The OAuth client is one the gateway registers itself at the provider (Miro). */
export interface OAuth2RegisteredClientSpec {
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
   * secret to paste (ADRs oauth-client-registered-by-the-gateway,
   * gmail-over-imap-with-an-app-password).
   */
  readonly clientRegistration: OAuth2ClientRegistration;
  /** Never set on this variant: one client source per spec. */
  readonly broker?: never;
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
