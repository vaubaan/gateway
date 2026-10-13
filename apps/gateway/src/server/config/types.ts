/**
 * Typed instance configuration (spec §4.3).
 *
 * One `InstanceConfig` is produced at boot by `loadInstanceConfig()` and
 * never read again from the environment: every module receives the typed
 * object (or a slice of it) through the composition root.
 */

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
  /** Claim carrying the group list (array or delimited string, resolved by P1.1). */
  readonly groups: string;
}

export interface IdpConfig {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly claims: IdpClaimMapping;
  /** Empty list means "any domain the IdP authenticates". */
  readonly allowedEmailDomains: readonly string[];
}

/**
 * The admin rule (spec §4.3): who is operator once the bootstrap token is
 * revoked. At least one of the two members is non-empty.
 */
export interface AdminRule {
  /** IdP group name whose members are operators, or `null`. */
  readonly group: string | null;
  /** Explicit list of operator emails (lower-cased). */
  readonly emails: readonly string[];
}

/**
 * The app the company registered at a provider. Which fields a given
 * provider needs is declared by its plugin (`CredentialSpec`, P0.2); the
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
  readonly enabled: boolean;
  readonly collectorUrl: URL;
}

export interface InstanceConfig {
  /** Public origin of the instance, always https, no trailing slash. */
  readonly publicUrl: URL;
  /** IPs or CIDR blocks whose `X-Forwarded-For` is trusted. Empty: none. */
  readonly trustedProxies: readonly string[];
  readonly store: { readonly path: string };
  readonly encryption: EncryptionConfig;
  /** `null` until the IdP is configured; the bootstrap token is then required. */
  readonly idp: IdpConfig | null;
  readonly admin: AdminRule;
  /** Provider apps keyed by plugin id. Ids are validated against the registry by the root. */
  readonly providers: ReadonlyMap<string, ProviderAppConfig>;
  readonly bootstrapToken: string | null;
  readonly telemetry: TelemetryConfig;
  readonly retentionDays: number;
  readonly requests: { readonly expirySeconds: number };
  readonly approvals: { readonly expirySeconds: number };
  readonly log: { readonly level: LogLevel };
}

/** Every secret string of a configuration, for the log redactor. */
export function secretValues(config: InstanceConfig): string[] {
  const out: string[] = [];
  if (config.idp) out.push(config.idp.clientSecret);
  if (config.bootstrapToken) out.push(config.bootstrapToken);
  for (const app of config.providers.values()) {
    if (app.clientSecret) out.push(app.clientSecret);
    if (app.privateKey) out.push(app.privateKey);
  }
  out.push(Buffer.from(config.encryption.masterKey).toString('base64'));
  for (const key of config.encryption.previousKeys.values()) {
    out.push(Buffer.from(key).toString('base64'));
  }
  return out.filter((s) => s.length > 0);
}
