/**
 * Typed instance configuration (spec §4.3).
 *
 * One `InstanceConfig` is produced at boot by `loadInstanceConfig()` and
 * never read again from the environment: every module receives the typed
 * object (or a slice of it) through the composition root.
 */

import type { TelemetryLevel } from '@vaubaan/telemetry';

import type { ClientIpHeader } from '../http/client-ip';
import type { RestoreSource } from './restore-source';
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

/**
 * The admin rule of the configuration (spec §4.3): optional, a seed. The boot applies
 * it once while the store names no administrator; afterwards the administrators live
 * in the store and a changed rule is only shown (ADR administrators-live-in-the-instance).
 * Both members empty: no rule.
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

export interface EncryptionConfig {
  /** Raw 32-byte master key currently used to encrypt. */
  readonly masterKey: Uint8Array;
  /** Version stamped on every blob encrypted from now on (>= 1). */
  readonly keyVersion: number;
  /** Older master keys still accepted for decryption, by version. */
  readonly previousKeys: ReadonlyMap<number, Uint8Array>;
  /**
   * The file the master key is read from (`VAUBAAN_MASTER_KEY_FILE`, or `${file:…}`
   * as the whole value of `encryption.master_key`); `null` when the key is given by
   * value. The path is not a secret; the content is.
   */
  readonly masterKeyFile: string | null;
  /**
   * `encryption.generate_master_key`: the instance writes the key file at its first
   * start when it is absent (ADR master-key-generated-and-handed-over-by-the-instance).
   */
  readonly generateMasterKey: boolean;
  /**
   * `encryption.accept_key_beside_store`: the operator knows the key file shares a mount
   * with the store and keeps the volume's copies apart; the boot does not warn.
   */
  readonly acceptKeyBesideStore: boolean;
}

/** What an encryptor is built from: the keys of the block, without its provenance. */
export type EncryptionKeys = Pick<EncryptionConfig, 'masterKey' | 'keyVersion' | 'previousKeys'>;

/**
 * Why the master key file named by the configuration may be absent at a start:
 * the instance is to generate it (`encryption.generate_master_key`), or a restore
 * is configured (`restore.from`) and the setup receives the key of the copy.
 */
export type AbsentMasterKeyReason = 'generate' | 'restore';

/**
 * Everything the configuration says but the encryption block: what a start
 * without the master key can rely on (where the store is, the public URL, the
 * bootstrap token, the log level) before the key exists.
 */
export type SetupConfig = Omit<InstanceConfig, 'encryption'>;

/** How the SMTP relay is reached: STARTTLS on a submission port, TLS from the first byte, or clear text (a local relay). */
export const MAIL_TLS_MODES = ['starttls', 'implicit', 'none'] as const;
export type MailTlsMode = (typeof MAIL_TLS_MODES)[number];

export function isMailTlsMode(raw: string): raw is MailTlsMode {
  return (MAIL_TLS_MODES as readonly string[]).includes(raw);
}

/**
 * Mail delivery (`mail.*`; ADR local-accounts-sign-in-provider, D6): the relay the
 * instance sends its own mail through — the links of the sign-in accounts. `null` when
 * the configuration sets no relay: the links are then handed over by an administrator.
 */
export interface MailConfig {
  readonly smtpHost: string;
  readonly smtpPort: number;
  /** `null`: the relay takes mail without authentication (a local relay). */
  readonly smtpUser: string | null;
  readonly smtpPassword: string | null;
  /** The sender, as `Name <address>` or a bare address. */
  readonly from: string;
  readonly tls: MailTlsMode;
}

export interface TelemetryConfig {
  /** The value of `telemetry.enabled`, `false` when the configuration does not set it. */
  readonly enabled: boolean;
  /**
   * True when the mounted file or the environment sets `telemetry.enabled`,
   * to either value: the configuration then wins over the Admin toggle
   * (handbook telemetry, Start here).
   */
  readonly enabledSetByConfig: boolean;
  /**
   * What an enabled instance sends (`telemetry.level`, default `usage-stats`):
   * plugin-health reports only, or also the decision reports and the daily
   * instance profile (spec §9; ADR telemetry-two-levels-behind-a-vercel-collector).
   */
  readonly level: TelemetryLevel;
  readonly collectorUrl: URL;
}

/** Where a self resource comes from: the `self_resources` key, or the platform the instance runs on. */
export type SelfResourceSource = 'config' | 'railway' | 'fly';

/**
 * A service resource that hosts or runs this instance (SEC 2026-10-15 H1):
 * never a mission resource — not offered at issuance, left out of a
 * mission's resources at execution, flagged on the account page. Host-level:
 * no plugin can add or remove one.
 */
export interface SelfResource {
  /** A plugin id (`railway`, `fly`). */
  readonly service: string;
  /** The resource ref as discovery stores it (a Railway project id, a Fly app name). */
  readonly ref: string;
  readonly source: SelfResourceSource;
}

/**
 * Restore at first boot (docs/handbook/store.md):
 * where a store copy comes from, its expected SHA-256, and the largest copy accepted.
 * `from` is `null` when nothing is to be restored.
 */
export interface RestoreConfig {
  readonly from: RestoreSource | null;
  /** 64 lower-case hexadecimal characters; required whenever `from` is set. */
  readonly sha256: string | null;
  readonly maxBytes: number;
}

/**
 * The S3-compatible bucket the scheduled backup uploads to (ADR
 * scheduled-encrypted-backup-to-object-storage, D1).
 */
export interface BackupBucketConfig {
  /** https, or http for a loopback host only; an origin, nothing else. */
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  /** Literal key prefix, possibly empty; end it with `/` for a folder. */
  readonly prefix: string;
  /** `true`: `<endpoint>/<bucket>/<key>`; `false`: `<bucket>.<endpoint host>/<key>`. */
  readonly pathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * Scheduled, encrypted, self-checked backup (`backup.*`). `null` in `InstanceConfig`
 * when no `backup.s3.*` key is set: the instance backs nothing up.
 */
export interface BackupConfig {
  readonly s3: BackupBucketConfig;
  /** Seconds between two runs: from 3600 to 86400, dividing a day. */
  readonly everySeconds: number;
  /** Minutes after midnight UTC of the day's first run (`backup.at`). */
  readonly atMinutes: number;
  /** Backups kept in the bucket; 0 keeps every one. */
  readonly keep: number;
}

/**
 * An OAuth broker the instance is enrolled with (`oauth_brokers.<name>.*`; ADR
 * google-calendar-through-an-oauth-broker D1): a service outside the gateway
 * that owns an OAuth client at a provider and runs the authorization-code flow
 * for the instance. The gateway is its client (handbook oauth-broker-contract).
 */
export interface OAuthBrokerConfig {
  /** The block's name (`main`), as written. */
  readonly name: string;
  /** Base URL of the four calls: https (http for a loopback host only), no trailing slash. */
  readonly url: URL;
  /** The broker key, sent as a Bearer on every call. A secret. */
  readonly key: string;
  /**
   * The broker providers it serves (`google`), lower-cased. Empty: the default
   * broker, which serves every provider no other broker lists.
   */
  readonly providers: readonly string[];
  /**
   * `required` (the default): every call goes over a TLS connection whose key
   * an attestation of an admitted broker version carries (ADR
   * oauth-broker-stateless-in-an-attested-enclave D4, D6). `none`: an
   * administrator's own broker outside an enclave, reached as any HTTPS
   * service; the interface says it is not attested.
   */
  readonly attestation: BrokerAttestationMode;
}

/** `oauth_brokers.<name>.attestation`. No value widens the allowlist shipped with the release. */
export type BrokerAttestationMode = 'required' | 'none';

/**
 * The ceilings of the instance (`limits.*`, spec §4.3 bis): `null` is unlimited, the
 * default. Each is enforced where an item would be added, never by cutting
 * (`server/limits`).
 */
export interface LimitsConfig {
  /** People not removed (`users.status = 'active'`). */
  readonly users: number | null;
  /** Connected accounts not revoked, every owner together. */
  readonly accounts: number | null;
  /** Missions neither revoked nor past their end, orphaned ones included. */
  readonly activeMissions: number | null;
}

/**
 * Where plugins come from besides the image (`plugins.*`, spec §4.3; ADR
 * plugins-bundled-or-pinned-by-the-operator).
 */
export interface PluginsConfig {
  /**
   * The directory the operator pins plugins in, one directory per plugin; `null` when
   * the configuration sets none (the image sets `VAUBAAN_PLUGINS_DIR=/plugins`).
   */
  readonly dir: string | null;
  /** The plugin ids the instance registers, in the order given; `null`: every plugin it knows. */
  readonly enabled: readonly string[] | null;
  /** The plugin ids an administrator may install without a signature; none by default. */
  readonly allowUnsigned: readonly string[];
  /** Start with the image's and the pinned versions only, ignoring installed ones. */
  readonly safeMode: boolean;
  /**
   * What plugins may reach inside the network (ADR plugins-reach-the-public-internet-only):
   * host names, IP addresses and CIDR ranges, as written; none by default.
   */
  readonly privateHosts: readonly string[];
}

/** The published versions feed (`updates.*`, spec §4.3). */
export interface UpdatesConfig {
  /** Whether the instance reads the feed at start and daily. */
  readonly check: boolean;
  readonly feedUrl: URL;
}

/** The user docs a page's (i) opens (`docs.*`). */
export interface DocsConfig {
  /** The docs root, no trailing slash; a service's page is `../plugins/<id>` beside it. */
  readonly url: URL;
}

/** The operator's counters endpoint (`ops.*`, spec §4.3 bis). */
export interface OpsConfig {
  /** The bearer of `GET /ops/stats`; `null`: the endpoint does not exist (404). */
  readonly token: string | null;
}

export interface InstanceConfig {
  /** Public origin of the instance, always https, no trailing slash. */
  readonly publicUrl: URL;
  /**
   * The instance's name (`instance_name`), trimmed and checked
   * (`checkInstanceName`). `null` when the configuration does not set it:
   * Administration may then set it, and without either the interface shows
   * the host of `publicUrl` (`server/instance`).
   */
  readonly instanceName: string | null;
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
  readonly restore: RestoreConfig;
  readonly encryption: EncryptionConfig;
  /**
   * The sign-in providers of the `sign_in.<id>.*` keys, in the order of the file then
   * the environment: the providers the configuration sets; with none, the bootstrap
   * token is required.
   */
  readonly signIn: readonly SignInProvider[];
  readonly admin: AdminRule;
  /**
   * Keys and variables of earlier versions the instance no longer reads, as
   * written (`providers.gmail.client_id`, `VAUBAAN_PROVIDER_GMAIL_CLIENT_ID`):
   * the OAuth clients an administrator declared (ADR
   * gmail-over-imap-with-an-app-password). They do not stop the boot; the root
   * logs one warning each.
   */
  readonly retiredKeys: readonly string[];
  /**
   * The keys and variables of the retired authorization server (`oauth.*`,
   * `VAUBAAN_OAUTH_ACCESS_TOKEN_TTL`, …) the configuration still sets (ADR
   * platform-management-is-a-plugin-on-the-execution-door). Never read; the root
   * says once that they are ignored, and the instance starts.
   */
  readonly retiredManagementKeys: readonly string[];
  /**
   * Old names of renamed keys and variables the configuration still uses
   * (`limits.connections`, `VAUBAAN_LIMITS_CONNECTIONS`; ADR
   * one-word-per-thing-account-service-plugin): read under their new name, the
   * root warns once for each.
   */
  readonly deprecatedKeys: readonly { readonly old: string; readonly current: string }[];
  readonly bootstrapToken: string | null;
  readonly telemetry: TelemetryConfig;
  /** Mail delivery, or `null` when no relay is configured. */
  readonly mail: MailConfig | null;
  /** The scheduled backup, or `null` when no bucket is configured. */
  readonly backup: BackupConfig | null;
  readonly retentionDays: number;
  readonly requests: { readonly expirySeconds: number };
  readonly approvals: { readonly expirySeconds: number };
  /**
   * Trust-raise proposals (risk model §4.7): how many approvals granted on one
   * macro-action of one resource set, with no refusal since its trust level changed,
   * before the creator is offered to raise it.
   */
  readonly trustRaise: { readonly afterApprovals: number };
  /** Surface rate limit of the execution door: requests per minute, per mission (spec §6). */
  readonly mcp: { readonly rateLimitPerMinute: number };
  /**
   * The execution door's plugin calls: how long one call may wait for its service, in
   * seconds, before it is stopped and answered as a timeout.
   */
  readonly execution: { readonly callTimeoutSeconds: number };
  /**
   * The git remote (spec §4.1 ter): the largest push accepted, in bytes, and
   * how long one git request may last, in seconds. Both fail closed.
   */
  readonly git: { readonly maxPackBytes: number; readonly requestTimeoutSeconds: number };
  /**
   * `accounts.refresh_interval`: how often every account in use refreshes its resources
   * and its key's rights on its own, in seconds; 0 turns the automatic refresh off,
   * hourly and on open (`server/accounts/account-refresh.ts`).
   */
  readonly accounts: { readonly refreshIntervalSeconds: number };
  /** Ceilings on users, accounts and active missions; each `null` when unlimited. */
  readonly limits: LimitsConfig;
  /** The counters endpoint for the operator's monitoring. */
  readonly ops: OpsConfig;
  /** The plugins directory and the plugins the instance registers. */
  readonly plugins: PluginsConfig;
  /** The published versions feed the instance compares itself with. */
  readonly updates: UpdatesConfig;
  /** Where the interface's doc links lead. */
  readonly docs: DocsConfig;
  /**
   * The OAuth brokers of `oauth_brokers.<name>.*`, in the order of the tree.
   * Empty: a plugin whose client is a broker's is listed as not configured.
   */
  readonly oauthBrokers: readonly OAuthBrokerConfig[];
  readonly log: { readonly level: LogLevel };
}

/**
 * Every secret string of a configuration, for the log redactor. A `SetupConfig`
 * (setup mode: no master key yet) yields everything but the keys.
 */
export function secretValues(config: InstanceConfig | SetupConfig): string[] {
  const out: string[] = [];
  for (const signInProvider of config.signIn) {
    if (signInProvider.kind !== 'local') out.push(signInProvider.clientSecret);
  }
  if (config.bootstrapToken) out.push(config.bootstrapToken);
  if (config.ops.token) out.push(config.ops.token);
  if ('mail' in config && config.mail?.smtpPassword) out.push(config.mail.smtpPassword);
  if (config.backup) out.push(config.backup.s3.secretAccessKey);
  for (const broker of config.oauthBrokers) out.push(broker.key);
  // A presigned URL is the credential itself; a file path is harmless but treated alike.
  const from = config.restore.from;
  if (from) out.push(from.kind === 'url' ? from.url.href : from.path);
  if ('encryption' in config) {
    out.push(...keyEncodings(config.encryption.masterKey));
    for (const key of config.encryption.previousKeys.values()) out.push(...keyEncodings(key));
  }
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
