/**
 * Typed instance configuration (spec §4.3).
 *
 * One `InstanceConfig` is produced at boot by `loadInstanceConfig()` and
 * never read again from the environment: every module receives the typed
 * object (or a slice of it) through the composition root.
 */

import type { ClientIpHeader } from '../http/client-ip';
import type { SignInProvider } from './sign-in';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(raw: string): raw is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(raw);
}

export interface IdpClaimMapping {
  /** Claim carrying the stable subject identifier. */
  readonly sub: string;
  /** Claim carrying the email address. */
  readonly email: string;
  /** Claim carrying the group list (array or delimited string, resolved at sign-in). */
  readonly groups: string;
  /**
   * Claim saying the provider verified the email (`true`). Absent: `email_verified`
   * (OpenID Connect Core §5.1). Entra ID: `xms_edov` ("email domain owner verified").
   */
  readonly emailVerified?: string;
}

export interface IdpConfig {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly claims: IdpClaimMapping;
  /** Empty list means "any domain the IdP authenticates" (a company directory only). */
  readonly allowedEmailDomains: readonly string[];
  /** Only invited addresses and the admin emails are admitted (`idp.invitation_only`). */
  readonly invitationOnly: boolean;
}

/**
 * The admin rule (spec §4.3): who is operator once the bootstrap token is
 * revoked. At least one of the two members is non-empty.
 */
export interface AdminRule {
  /**
   * The group whose members are operators, as written: `<provider>:<group>`, or a
   * bare group name while one sign-in provider is configured (`resolveAdminGroup`,
   * `sign-in.ts`). `null` when the rule lists emails only.
   */
  readonly group: string | null;
  /** Explicit list of operator emails (lower-cased). */
  readonly emails: readonly string[];
}

/**
 * The app the company registered at a provider. Which fields a given
 * provider needs is declared by its plugin (`CredentialSpec`); the
 * loader only guarantees the shape and resolves secret references.
 */
export interface ProviderAppConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly appId?: string;
  readonly appSlug?: string;
  readonly privateKey?: string;
}

export const PROVIDER_APP_FIELDS = [
  'client_id',
  'client_secret',
  'app_id',
  'app_slug',
  'private_key',
] as const;
export type ProviderAppField = (typeof PROVIDER_APP_FIELDS)[number];

export function isProviderAppField(raw: string): raw is ProviderAppField {
  return (PROVIDER_APP_FIELDS as readonly string[]).includes(raw);
}

/** YAML/env field → `ProviderAppConfig` property. Exhaustive: a field added to
 *  `PROVIDER_APP_FIELDS` without a property here fails to compile. */
export const PROVIDER_APP_FIELD_PROPERTY: Readonly<
  Record<ProviderAppField, keyof ProviderAppConfig>
> = {
  client_id: 'clientId',
  client_secret: 'clientSecret',
  app_id: 'appId',
  app_slug: 'appSlug',
  private_key: 'privateKey',
};

export interface EncryptionConfig {
  /** Raw 32-byte master key currently used to encrypt. */
  readonly masterKey: Uint8Array;
  /** Version stamped on every blob encrypted from now on (>= 1). */
  readonly keyVersion: number;
  /** Older master keys still accepted for decryption, by version. */
  readonly previousKeys: ReadonlyMap<number, Uint8Array>;
}

export interface TelemetryConfig {
  /** The value of `telemetry.enabled`, `false` when the configuration does not set it. */
  readonly enabled: boolean;
  /**
   * True when the mounted file or the environment sets `telemetry.enabled`,
   * to either value: the configuration then wins over the Admin toggle
   * (handbook telemetry, "Who decides").
   */
  readonly enabledSetByConfig: boolean;
  readonly collectorUrl: URL;
}

/**
 * Who may become an OAuth client of the management door (spec §4.1 bis; ADR
 * management-door-authorization-server):
 *
 * - `open`: any client that registers may ask users for a delegation at once;
 * - `operator-approved`: a client waits for an operator's approval, except, when
 *   `autoApproveLoopback` is set, a client that can only redirect to the loopback
 *   interface of the user's own machine;
 * - `closed`: nothing registers; only the clients an operator approved are usable.
 */
export const CLIENT_REGISTRATION_POLICIES = ['open', 'operator-approved', 'closed'] as const;
export type ClientRegistrationPolicy = (typeof CLIENT_REGISTRATION_POLICIES)[number];

export function isClientRegistrationPolicy(raw: string): raw is ClientRegistrationPolicy {
  return (CLIENT_REGISTRATION_POLICIES as readonly string[]).includes(raw);
}

/** The authorization server of the management door (spec §4.1 bis, §6). */
export interface OAuthConfig {
  /** Lifetime of a delegated access token: short (spec §6), at most one hour. */
  readonly accessTokenTtlSeconds: number;
  /** Lifetime of a refresh token; each rotation starts it again. */
  readonly refreshTokenTtlSeconds: number;
  /**
   * Absolute lifetime of a delegation, counted from the user's consent (spec §0
   * "Delegation"): past it no token of the delegation is issued or accepted,
   * whatever was renewed, and the client must obtain the consent again.
   */
  readonly delegationMaxLifetimeSeconds: number;
  /**
   * For how long the refresh token that was just rotated may be presented once
   * more without ending the delegation (two processes sharing one stored token
   * and renewing together). 0 disables the window; at most 60.
   */
  readonly refreshReuseWindowSeconds: number;
  readonly clientRegistration: {
    readonly policy: ClientRegistrationPolicy;
    /** Under `operator-approved`: loopback-only clients need no approval. */
    readonly autoApproveLoopback: boolean;
    /**
     * Accept `client_id`s that are https URLs of Client ID Metadata Documents. The
     * instance then fetches documents from the internet on a signed-in user's request.
     */
    readonly metadataDocuments: boolean;
  };
}

/** Where a self resource comes from: the `self_resources` key, or the platform the instance runs on. */
export type SelfResourceSource = 'config' | 'railway';

/**
 * A provider resource that hosts or runs this instance (SEC 2026-10-15 H1):
 * never a mission resource — not offered at issuance, left out of a
 * mission's resources at execution, flagged on the account page. Host-level:
 * no plugin can add or remove one.
 */
export interface SelfResource {
  /** A plugin id (`railway`). */
  readonly provider: string;
  /** The resource ref as discovery stores it (a Railway project id). */
  readonly ref: string;
  readonly source: SelfResourceSource;
}

export interface InstanceConfig {
  /** Public origin of the instance, always https, no trailing slash. */
  readonly publicUrl: URL;
  /** IPs or CIDR blocks whose `X-Forwarded-For` is trusted. Empty: none. */
  readonly trustedProxies: readonly string[];
  /** The resources of this instance's own hosting; see `SelfResource`. */
  readonly selfResources: readonly SelfResource[];
  /**
   * Trusted-edge mode: the one header the edge in front of the instance overwrites
   * with the client address (`x-real-ip` on Railway). `null` (the default): the address
   * comes from `X-Forwarded-For` through `trustedProxies`, or is unknown.
   */
  readonly clientIpHeader: ClientIpHeader | null;
  readonly store: { readonly path: string };
  readonly encryption: EncryptionConfig;
  /**
   * The single-provider keys (`idp.*`): the provider `idp` (`LEGACY_PROVIDER_ID`),
   * `null` when they are absent.
   */
  readonly idp: IdpConfig | null;
  /**
   * The sign-in providers of the `sign_in.<id>.*` keys, in the order of the file then
   * the environment. Together with `idp` they are the providers the configuration
   * sets (`fileSignInProviders`); with none, the bootstrap token is required.
   */
  readonly signIn: readonly SignInProvider[];
  readonly admin: AdminRule;
  /** Provider apps keyed by plugin id. Ids are validated against the registry by the root. */
  readonly providers: ReadonlyMap<string, ProviderAppConfig>;
  readonly bootstrapToken: string | null;
  readonly telemetry: TelemetryConfig;
  readonly retentionDays: number;
  readonly requests: { readonly expirySeconds: number };
  readonly approvals: { readonly expirySeconds: number };
  /** Surface rate limit of the execution door: requests per minute, per mission (spec §6). */
  readonly mcp: { readonly rateLimitPerMinute: number };
  /**
   * The git remote (spec §4.1 ter): the largest push accepted, in bytes, and
   * how long one git request may last, in seconds. Both fail closed.
   */
  readonly git: { readonly maxPackBytes: number; readonly requestTimeoutSeconds: number };
  /** Authorization server of the management door: token lifetimes, who may register. */
  readonly oauth: OAuthConfig;
  readonly log: { readonly level: LogLevel };
}

/** Every secret string of a configuration, for the log redactor. */
export function secretValues(config: InstanceConfig): string[] {
  const out: string[] = [];
  if (config.idp) out.push(config.idp.clientSecret);
  for (const provider of config.signIn) out.push(provider.clientSecret);
  if (config.bootstrapToken) out.push(config.bootstrapToken);
  for (const app of config.providers.values()) {
    if (app.clientSecret) out.push(app.clientSecret);
    if (app.privateKey) out.push(app.privateKey);
  }
  out.push(...keyEncodings(config.encryption.masterKey));
  for (const key of config.encryption.previousKeys.values()) out.push(...keyEncodings(key));
  return out.filter((s) => s.length > 0);
}

/**
 * Every text form the loader accepts for a key (standard base64 with or
 * without padding, base64url): the redactor must match the form the operator
 * actually configured, which the decoded bytes no longer tell.
 */
function keyEncodings(key: Uint8Array): string[] {
  const bytes = Buffer.from(key);
  const standard = bytes.toString('base64');
  const urlSafe = bytes.toString('base64url');
  return [...new Set([standard, standard.replace(/=+$/, ''), urlSafe])];
}
