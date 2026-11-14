/**
 * `loadInstanceConfig()` — the only way an `InstanceConfig` comes to exist.
 *
 * Precedence (ADR docker-image-and-config-format): the mounted YAML file wins
 * over environment variables, key by key. Validation collects every problem
 * and throws one `ConfigError` naming each YAML path and its variable(s).
 *
 * One absence is not a problem for the boot: the master key *file* that the
 * configuration names does not exist yet, and the configuration says what to do
 * about it (`encryption.generate_master_key`, or a configured restore).
 * `loadInstanceConfigOrSetup()` reports that as an outcome with everything else
 * validated (ADR master-key-generated-and-handed-over-by-the-instance); every
 * other caller — the operator commands — gets the error through
 * `loadInstanceConfig()`.
 */
import { isTelemetryLevel, TELEMETRY_LEVELS, type TelemetryLevel } from '@vaubaan/telemetry';

import { KEY_BYTES } from '../crypto/aead';
import { isClientIpHeader, isTrustedProxyEntry, type ClientIpHeader } from '../http/client-ip';
import { parseDuration } from './duration';
import { checkInstanceName, INSTANCE_NAME_PROBLEMS } from './instance-name';
import {
  admissionProblem,
  adminGroupProblem,
  GITHUB_DOT_COM,
  GITHUB_IS_NOT_OIDC,
  isGithubDotComHost,
  DEFAULT_LOCAL_PROVIDER_NAME,
  isSignInKind,
  isSignInProviderId,
  localProviderOf,
  issuerKey,
  normalizeEmailDomains,
  SIGN_IN_KINDS,
  type SignInProvider,
} from './sign-in';
import { ConfigError, IssueList } from './errors';
import {
  type AbsentSecretFile,
  type EnvSource,
  type FileReader,
  type SourceTrace,
  defaultFileReader,
  newSourceTrace,
} from './secret-refs';
import { parseRestoreSource, parseSha256 } from './restore-source';
import { readSelfResources } from './self-resources';
import {
  type RawTree,
  applyDeprecatedAliases,
  envNamesFor,
  getPath,
  isKeyRequired,
  isPlainObject,
  keySpec,
  mergeTrees,
  readEnvSource,
  readFileSource,
  retiredConfigKeys,
  retiredManagementKeys,
  RETIRED_IDP_ENV_PREFIX,
  RETIRED_IDP_KEY,
  secretEnvVariables,
  OAUTH_BROKER_BLOCK,
  OAUTH_BROKER_ENV_PREFIX,
  SIGN_IN_ENV_PREFIX,
} from './sources';
import {
  type AbsentMasterKeyReason,
  type AdminRule,
  type RestoreConfig,
  type SetupConfig,
  type EncryptionConfig,
  type InstanceConfig,
  LOG_LEVELS,
  type LimitsConfig,
  type PluginsConfig,
  type UpdatesConfig,
  type DocsConfig,
  type LogLevel,
  type OAuthBrokerConfig,
  isLogLevel,
  isMailTlsMode,
  MAIL_TLS_MODES,
  type MailConfig,
  type BackupConfig,
} from './types';
import {
  brokerSetProblems,
  isBrokerName,
  isBrokerProvider,
  OAUTH_BROKER_PROBLEMS,
  parseBrokerAttestation,
  parseBrokerUrl,
} from './oauth-brokers';
import { isBackupPeriod, isBucketName, parseBackupEndpoint, parseTimeOfDay } from './backup-config';

/** `git.max_pack_mb` is in mebibytes. */
const BYTES_PER_MEGABYTE = 1024 * 1024;

/** The master key is the AEAD key: one size, defined by the crypto module. */
export const MASTER_KEY_BYTES = KEY_BYTES;
// Defaults and bounds are those of the key table (`KEYS` in `sources.ts`).
const MIN_BOOTSTRAP_TOKEN_LENGTH = keySpec('bootstrap_token').minLength;
const MIN_OPS_TOKEN_LENGTH = keySpec('ops.token').minLength;
const DEFAULT_LOG_LEVEL: LogLevel = keySpec('log.level').default;

interface IntKey {
  readonly path: string;
  readonly default: number;
  readonly min: number;
}
interface OptionalIntKey {
  readonly path: string;
  readonly min: number;
}
interface BoolKey {
  readonly path: string;
  readonly default: boolean;
}
interface TextKey {
  readonly path: string;
  readonly default: string;
}

export interface LoadOptions {
  /** Defaults to `process.env`. */
  readonly env?: EnvSource;
  /** File reader used for the YAML file and every secret file. */
  readonly readFile?: FileReader;
}

export interface LoadedConfig {
  readonly config: InstanceConfig;
  /** Path of the YAML file that was merged in, or `null` for env-only. */
  readonly configFile: string | null;
  /**
   * The environment variables that carried a secret, or the path of one, into this
   * configuration: what `scrubSecretEnv` deletes once the configuration is loaded.
   */
  readonly secretEnvNames: readonly string[];
  /** The boot generated the master key file at this start (`compose/boot-config.ts`). */
  readonly masterKeyGenerated: boolean;
}

/**
 * The configuration without its master key: the file named for it does not exist,
 * and the configuration says what the boot does about it (`reason`). Everything
 * else has been validated as usual.
 */
export interface SetupOutcome {
  readonly kind: 'setup';
  readonly config: SetupConfig;
  /** The absent file, as the configuration names it. */
  readonly masterKeyFile: string;
  readonly reason: AbsentMasterKeyReason;
  readonly configFile: string | null;
  readonly secretEnvNames: readonly string[];
  /** The problem as `loadInstanceConfig()` would report it. */
  readonly issue: AbsentSecretFile;
}

export type ConfigLoadOutcome =
  { readonly kind: 'ready'; readonly loaded: LoadedConfig } | SetupOutcome;

const MASTER_KEY_PATH = 'encryption.master_key';
const GENERATE_PATH = 'encryption.generate_master_key';

/** What the two sources said about the master key, beside its value. */
interface MasterKeySource {
  /** The file the key is read from, when it is read from one: the winning source's. */
  readonly file: string | null;
  /** The absent key file the boot may tolerate, with the reason the configuration gives. */
  readonly absent: {
    readonly file: AbsentSecretFile;
    readonly reason: AbsentMasterKeyReason;
  } | null;
}

/**
 * Loads the configuration; an absent master key file is an outcome rather than an
 * error when the configuration says what to do about it. Any other problem, the
 * absent file included otherwise, is a `ConfigError` as with `loadInstanceConfig()`.
 */
export function loadInstanceConfigOrSetup(options: LoadOptions = {}): ConfigLoadOutcome {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? defaultFileReader;
  const issues = new IssueList();
  const envTrace = newSourceTrace();
  const fileTrace = newSourceTrace();

  const fromEnv = readEnvSource(env, issues, readFile, envTrace);
  const fromFile = readFileSource(env, issues, readFile, fileTrace);
  const deprecatedKeys = applyDeprecatedAliases(fromEnv, fromFile?.tree ?? null, env, issues);
  const raw = fromFile ? mergeTrees(fromEnv, fromFile.tree) : fromEnv;
  const masterKey = masterKeySource(raw, fromFile?.tree ?? null, envTrace, fileTrace, issues);
  const validated = validate(raw, issues, env, masterKey);
  const config = validated ? { ...validated, deprecatedKeys } : null;
  issues.throwIfAny();
  if (!config) throw new ConfigError(issues.items); // unreachable: validate() reports every failure
  const secretEnvNames = [
    ...new Set([...secretEnvVariables(env), ...(fromFile?.secretVariables ?? [])]),
  ].sort();
  const configFile = fromFile?.path ?? null;
  if (masterKey.absent) {
    const { encryption: _absent, ...rest } = config;
    return {
      kind: 'setup',
      config: rest,
      masterKeyFile: masterKey.absent.file.filePath,
      reason: masterKey.absent.reason,
      configFile,
      secretEnvNames,
      issue: masterKey.absent.file,
    };
  }
  return {
    kind: 'ready',
    loaded: { config, configFile, secretEnvNames, masterKeyGenerated: false },
  };
}

export function loadInstanceConfig(options: LoadOptions = {}): LoadedConfig {
  const outcome = loadInstanceConfigOrSetup(options);
  if (outcome.kind === 'ready') return outcome.loaded;
  const hint =
    outcome.reason === 'generate'
      ? ' (the gateway writes it at its first start; start the gateway first)'
      : ' (a restore needs the key the copy was sealed with; put the file back)';
  throw new ConfigError([
    { path: MASTER_KEY_PATH, env: outcome.issue.env, message: outcome.issue.message + hint },
  ]);
}

/**
 * Where the master key comes from, by the precedence of the sources: the YAML file
 * when it sets the key, else the environment. An absent key file of the winning
 * source is tolerated when the raw configuration enables generation or names a
 * restore source; every other absent secret file is reported as the problem it is.
 */
function masterKeySource(
  raw: RawTree,
  fileTree: RawTree | null,
  envTrace: SourceTrace,
  fileTrace: SourceTrace,
  issues: IssueList,
): MasterKeySource {
  const fileWins = fileTree !== null && getPath(fileTree, MASTER_KEY_PATH) !== undefined;
  const winner = fileWins ? fileTrace : envTrace;
  const reason = absenceReason(raw);
  let absent: MasterKeySource['absent'] = null;
  for (const trace of [envTrace, fileTrace]) {
    for (const file of trace.absentFiles) {
      if (
        file.keyPath === MASTER_KEY_PATH &&
        trace === winner &&
        reason !== null &&
        absent === null
      ) {
        absent = { file, reason };
        continue;
      }
      issues.add(file.keyPath, file.message, file.env);
    }
  }
  return { file: winner.secretFiles.get(MASTER_KEY_PATH) ?? absent?.file.filePath ?? null, absent };
}

function absenceReason(raw: RawTree): AbsentMasterKeyReason | null {
  if (getPath(raw, GENERATE_PATH) === true) return 'generate';
  const from = getPath(raw, 'restore.from');
  if (typeof from === 'string' && from.trim() !== '') return 'restore';
  return null;
}

/**
 * Loads the configuration from `process.env`, then deletes from `process.env` every
 * variable that carried a secret (the master keys, client secrets, private keys, the
 * bootstrap token, their `_FILE` paths, and the variables the YAML file references at a
 * secret key): the values live on in the returned configuration only, so a dump of
 * `process.env` or a child process sees none of them. What it cannot reach: the
 * process's initial environment block, which `/proc/<pid>/environ` keeps showing to its
 * own user and to root (docs/handbook/configuration.md).
 */
export function loadProcessConfig(): LoadedConfig {
  const loaded = loadInstanceConfig({ env: process.env });
  scrubSecretEnv(process.env, loaded.secretEnvNames);
  return loaded;
}

/** Deletes the named variables from `env` (`process.env` in production). */
export function scrubSecretEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): void {
  for (const name of names) {
    delete env[name];
  }
}

/* ------------------------------------------------------------------------ */
/* Validation                                                                */
/* ------------------------------------------------------------------------ */

class Reader {
  constructor(
    private readonly raw: RawTree,
    readonly issues: IssueList,
  ) {}

  has(path: string): boolean {
    return getPath(this.raw, path) !== undefined;
  }

  string(path: string, opts: { required?: boolean; fallback?: string } = {}): string | undefined {
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) {
      if (opts.fallback !== undefined) return opts.fallback;
      if (opts.required) this.issues.missing(path, envNamesFor(path));
      return undefined;
    }
    if (typeof value !== 'string') {
      this.issues.add(path, `expected a string, got ${typeName(value)}`, envNamesFor(path));
      return undefined;
    }
    if (value.trim() === '') {
      if (opts.required) this.issues.add(path, 'must not be empty', envNamesFor(path));
      return opts.fallback;
    }
    return value;
  }

  /** A string key with a default: the default stands in for an absent or empty value. */
  text(key: TextKey): string {
    return this.string(key.path, { fallback: key.default }) ?? key.default;
  }

  int(key: IntKey): number {
    const { path, default: fallback, min } = key;
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      this.issues.add(path, `expected an integer >= ${min}, got ${show(value)}`, envNamesFor(path));
      return fallback;
    }
    return value;
  }

  /** An integer key without a default: `null` when absent (a ceiling: unlimited). */
  optionalInt(key: OptionalIntKey): number | null {
    const { path, min } = key;
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      this.issues.add(path, `expected an integer >= ${min}, got ${show(value)}`, envNamesFor(path));
      return null;
    }
    return value;
  }

  bool(key: BoolKey): boolean {
    const { path, default: fallback } = key;
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') {
      this.issues.add(path, `expected true or false, got ${show(value)}`, envNamesFor(path));
      return fallback;
    }
    return value;
  }

  stringList(path: string): string[] {
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      this.issues.add(
        path,
        `expected a list of strings, got ${typeName(value)}`,
        envNamesFor(path),
      );
      return [];
    }
    return value.map((v) => v.trim()).filter((v) => v.length > 0);
  }

  duration(key: TextKey): number {
    const { path, default: fallback } = key;
    const text = this.string(path, { fallback }) ?? fallback;
    const seconds = parseDuration(text);
    if (seconds === null) {
      this.issues.add(path, `expected a duration like 30s, 10m, 24h or 7d, got "${text}"`, [
        ...envNamesFor(path),
      ]);
      return parseDuration(fallback) ?? 0;
    }
    return seconds;
  }

  url(
    path: string,
    opts: { required?: boolean; fallback?: string; https: boolean },
  ): URL | undefined {
    const text = this.string(path, { required: opts.required, fallback: opts.fallback });
    if (text === undefined) return undefined;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      this.issues.add(path, `is not a valid URL: "${text}"`, envNamesFor(path));
      return undefined;
    }
    if (opts.https && url.protocol !== 'https:') {
      this.issues.add(path, `must use https (got ${url.protocol.slice(0, -1)})`, envNamesFor(path));
      return undefined;
    }
    return url;
  }

  tree(path: string): RawTree | undefined {
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return undefined;
    if (!isPlainObject(value)) {
      this.issues.add(path, `expected a mapping, got ${typeName(value)}`, envNamesFor(path));
      return undefined;
    }
    return value;
  }
}

function validate(
  raw: RawTree,
  issues: IssueList,
  env: EnvSource,
  masterKey: MasterKeySource,
): InstanceConfig | null {
  const r = new Reader(raw, issues);
  const before = issues.items.length;

  const publicUrl = readPublicUrl(r);
  const instanceName = readInstanceName(r);
  const trustedProxies = readTrustedProxies(r);
  const selfResources = readSelfResources(r.stringList('self_resources'), env, (message) =>
    r.issues.add('self_resources', message, envNamesFor('self_resources')),
  );
  const clientIpHeader = readClientIpHeader(r, trustedProxies);
  requireAddressSource(r, env, trustedProxies, clientIpHeader);
  const storePath = r.string('store.path', { required: isKeyRequired(keySpec('store.path')) });
  const restore = readRestore(r);
  const encryption = readEncryption(r, masterKey, restore.from !== null);
  refuseSingleProviderKeys(r, raw, env);
  const signIn = readSignIn(r);
  const signInProviders = checkSignInProviders(r, signIn);
  const admin = readAdmin(r, signInProviders);
  const bootstrapToken = readBootstrapToken(r, signInProviders.length > 0);
  const limits = readLimits(r);
  const opsToken = readOpsToken(r);
  const plugins = readPlugins(r);
  const updates = readUpdates(r);
  const docs = readDocs(r);

  const mail = readMail(r);
  const backup = readBackup(r);
  const telemetryEnabled = r.bool(keySpec('telemetry.enabled'));
  // A null or mistyped value is not a decision: only a boolean pins the toggle.
  const telemetrySetByConfig = typeof getPath(raw, 'telemetry.enabled') === 'boolean';
  const telemetryLevel = readTelemetryLevel(r);
  const collector = keySpec('telemetry.collector_url');
  const collectorUrl = r.url(collector.path, {
    fallback: collector.default,
    https: collector.https,
  });

  const retentionDays = r.int(keySpec('retention_days'));
  const requestExpiry = r.duration(keySpec('requests.expiry'));
  const approvalExpiry = r.duration(keySpec('approvals.expiry'));
  const trustRaiseAfterApprovals = r.int(keySpec('trust_raise.after_approvals'));
  const mcpRateLimit = r.int(keySpec('mcp.rate_limit_per_minute'));
  const callTimeoutSeconds = r.int(keySpec('execution.call_timeout_seconds'));
  const gitMaxPackMb = r.int(keySpec('git.max_pack_mb'));
  const gitRequestTimeout = r.duration(keySpec('git.request_timeout'));
  const oauthBrokers = readOAuthBrokers(r);
  const level = readLogLevel(r);

  if (issues.items.length > before) return null;
  if (!publicUrl || !storePath || !encryption || !collectorUrl || !updates || !docs) return null;
  // An absent key file the boot tolerates: the block is complete but for the key
  // itself, which the caller takes out again (`SetupOutcome`).

  return {
    publicUrl,
    instanceName,
    trustedProxies,
    selfResources,
    clientIpHeader,
    store: { path: storePath },
    restore,
    encryption,
    signIn,
    admin,
    retiredKeys: retiredConfigKeys(raw, env),
    retiredManagementKeys: retiredManagementKeys(raw, env),
    deprecatedKeys: [],
    bootstrapToken,
    telemetry: {
      enabled: telemetryEnabled,
      enabledSetByConfig: telemetrySetByConfig,
      level: telemetryLevel,
      collectorUrl,
    },
    mail,
    backup,
    retentionDays,
    requests: { expirySeconds: requestExpiry },
    approvals: { expirySeconds: approvalExpiry },
    trustRaise: { afterApprovals: trustRaiseAfterApprovals },
    mcp: { rateLimitPerMinute: mcpRateLimit },
    execution: { callTimeoutSeconds },
    git: {
      maxPackBytes: gitMaxPackMb * BYTES_PER_MEGABYTE,
      requestTimeoutSeconds: gitRequestTimeout,
    },
    limits,
    ops: { token: opsToken },
    plugins,
    updates,
    docs,
    oauthBrokers,
    log: { level },
  };
}

/** https, no query or fragment, trailing slash stripped (a sub-path is kept). */
function readPublicUrl(r: Reader): URL | undefined {
  const key = keySpec('public_url');
  const publicUrl = r.url(key.path, { required: isKeyRequired(key), https: key.https });
  if (!publicUrl) return undefined;
  if (publicUrl.search || publicUrl.hash) {
    r.issues.add(
      'public_url',
      'must not carry a query string or fragment',
      envNamesFor('public_url'),
    );
  }
  publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, '');
  return publicUrl;
}

/**
 * `instance_name`: optional, trimmed, within the bounds of `checkInstanceName`.
 * An absent or blank value is not a decision: Administration decides then.
 */
function readInstanceName(r: Reader): string | null {
  const path = 'instance_name';
  const raw = r.string(path);
  if (raw === undefined) return null;
  const check = checkInstanceName(raw);
  if (!check.ok) {
    r.issues.add(path, INSTANCE_NAME_PROBLEMS[check.problem], envNamesFor(path));
    return null;
  }
  return check.name;
}

function readTrustedProxies(r: Reader): string[] {
  const trustedProxies = r.stringList('trusted_proxies');
  for (const entry of trustedProxies) {
    if (!isTrustedProxyEntry(entry)) {
      r.issues.add(
        'trusted_proxies',
        `"${entry}" is neither an IP address nor a CIDR block`,
        envNamesFor('trusted_proxies'),
      );
    }
  }
  return trustedProxies;
}

/**
 * `client_ip_header`: the single-value header a trusted edge writes (trusted-edge mode,
 * off by default). It replaces `X-Forwarded-For` reading, so it excludes `trusted_proxies`.
 */
function readClientIpHeader(r: Reader, trustedProxies: readonly string[]): ClientIpHeader | null {
  const path = 'client_ip_header';
  const raw = r.string(path);
  if (raw === undefined) return null;
  const header = raw.trim().toLowerCase();
  if (!isClientIpHeader(header)) {
    r.issues.add(path, `expected one of ${keySpec(path).oneOf.join(', ')}, got "${raw}"`, [
      ...envNamesFor(path),
    ]);
    return null;
  }
  if (trustedProxies.length > 0) {
    r.issues.add(
      path,
      'set either client_ip_header (an edge that overwrites one header) or trusted_proxies (proxies that append to X-Forwarded-For), not both',
      [...envNamesFor(path), ...envNamesFor('trusted_proxies')],
    );
    return null;
  }
  return header;
}

/**
 * In production (`NODE_ENV=production`: the image, never the demo nor a test), a
 * source of client addresses is required: without `trusted_proxies` or
 * `client_ip_header` every address-keyed window is one shared by all callers, so
 * one client can hold everybody's sign-in and approval links at 429 (threat model
 * A2). `accept_shared_address_windows` states that choice instead.
 */
function requireAddressSource(
  r: Reader,
  env: EnvSource,
  trustedProxies: readonly string[],
  clientIpHeader: ClientIpHeader | null,
): void {
  const accepted = r.bool(keySpec('accept_shared_address_windows'));
  if (env.NODE_ENV !== 'production' || accepted) return;
  if (trustedProxies.length > 0 || clientIpHeader !== null) return;
  // A client_ip_header that was refused is already an issue of its own.
  if (r.string('client_ip_header') !== undefined) return;
  r.issues.add(
    'trusted_proxies',
    'a source of client addresses is required in production: set trusted_proxies to the address of the reverse proxy in front of the instance, or client_ip_header behind an edge that overwrites it; or set accept_shared_address_windows to share every address-keyed limit among all callers (deploy/README.md)',
    [
      ...envNamesFor('trusted_proxies'),
      ...envNamesFor('client_ip_header'),
      ...envNamesFor('accept_shared_address_windows'),
    ],
  );
}

/**
 * `restore.*` (docs/handbook/store.md): the
 * source is a secret — a problem with it is named, the value never echoed — and the
 * expected SHA-256 is required with it.
 */
function readRestore(r: Reader): RestoreConfig {
  const maxSpec = keySpec('restore.max_mb');
  let maxMb = r.int(maxSpec);
  if (maxMb > maxSpec.max) {
    r.issues.add(maxSpec.path, `expected an integer from ${maxSpec.min} to ${maxSpec.max}`, [
      ...envNamesFor(maxSpec.path),
    ]);
    maxMb = maxSpec.default;
  }
  const maxBytes = maxMb * BYTES_PER_MEGABYTE;

  const rawFrom = r.string('restore.from');
  let from: RestoreConfig['from'] = null;
  if (rawFrom !== undefined) {
    const parsed = parseRestoreSource(rawFrom);
    if (parsed.ok) from = parsed.source;
    else r.issues.add('restore.from', parsed.problem, envNamesFor('restore.from'));
  }
  const rawSha = r.string('restore.sha256');
  let sha256: string | null = null;
  if (rawSha !== undefined) {
    sha256 = parseSha256(rawSha);
    if (sha256 === null) {
      r.issues.add('restore.sha256', 'expected 64 hexadecimal characters (a SHA-256)', [
        ...envNamesFor('restore.sha256'),
      ]);
    }
  } else if (rawFrom !== undefined) {
    r.issues.add(
      'restore.sha256',
      'required with restore.from: the SHA-256 of the store copy to restore',
      envNamesFor('restore.sha256'),
    );
  }
  return { from, sha256, maxBytes };
}

/** Required while the configuration sets no sign-in provider; long enough to resist guessing. */
function readBootstrapToken(r: Reader, hasSignInProvider: boolean): string | null {
  const required = isKeyRequired(keySpec('bootstrap_token'), hasSignInProvider);
  const bootstrapToken = r.string('bootstrap_token', { required }) ?? null;
  if (bootstrapToken !== null && bootstrapToken.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
    r.issues.add(
      'bootstrap_token',
      `must be at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters long`,
      envNamesFor('bootstrap_token'),
    );
  }
  return bootstrapToken;
}

/**
 * `limits.*` (spec §4.3 bis): each a positive whole number, absent unlimited. A
 * ceiling under the current count is accepted: nothing is cut, additions are refused.
 */
function readLimits(r: Reader): LimitsConfig {
  return {
    users: r.optionalInt(keySpec('limits.users')),
    accounts: r.optionalInt(keySpec('limits.accounts')),
    activeMissions: r.optionalInt(keySpec('limits.active_missions')),
  };
}

/** The shape of a plugin id (`isProviderId` of the SDK's vocabulary: a lowercase slug). */
const PLUGIN_ID_SHAPE = /^[a-z][a-z0-9-]*$/;

/**
 * `plugins.*` (ADR plugins-bundled-or-pinned-by-the-operator). `plugins.dir` is a path
 * read at boot (`server/plugins`), checked there; `plugins.enabled` a list of plugin ids.
 * Absent or empty (a blank variable, as for every key) is every plugin; whether each id
 * names a known plugin is checked once the plugins are loaded.
 */
function readPlugins(r: Reader): PluginsConfig {
  const dir = r.string('plugins.dir')?.trim() ?? null;
  const path = 'plugins.enabled';
  const listed = r.stringList(path);
  if (listed.length === 0) return { dir, enabled: null };
  const malformed = listed.filter((id) => !PLUGIN_ID_SHAPE.test(id));
  if (malformed.length > 0) {
    r.issues.add(path, `not plugin ids: ${malformed.map(show).join(', ')}`, envNamesFor(path));
  }
  return { dir, enabled: [...new Set(listed)] };
}

/** `updates.*`: the versions check, on by default, and its https feed. */
function readUpdates(r: Reader): UpdatesConfig | undefined {
  const check = r.bool(keySpec('updates.check'));
  const feed = keySpec('updates.feed_url');
  const feedUrl = r.url(feed.path, { fallback: feed.default, https: feed.https });
  return feedUrl ? { check, feedUrl } : undefined;
}

/** `docs.url`: the https docs root the interface links to, trailing slash stripped. */
function readDocs(r: Reader): DocsConfig | undefined {
  const spec = keySpec('docs.url');
  const url = r.url(spec.path, { fallback: spec.default, https: spec.https });
  if (!url) return undefined;
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { url };
}

/** `ops.token`: optional; when set, long enough to resist guessing. */
function readOpsToken(r: Reader): string | null {
  const path = 'ops.token';
  const token = r.string(path) ?? null;
  if (token !== null && token.length < MIN_OPS_TOKEN_LENGTH) {
    r.issues.add(
      path,
      `must be at least ${MIN_OPS_TOKEN_LENGTH} characters long`,
      envNamesFor(path),
    );
    return null;
  }
  return token;
}

/**
 * `oauth_brokers.<name>.*` (ADR google-calendar-through-an-oauth-broker D1): one
 * broker per name, in the order of the tree; `url` and `key` required,
 * `providers` optional (none: the default broker), `attestation` `required`
 * (the default) or `none`. The rules across brokers
 * are `brokerSetProblems`'.
 */
function readOAuthBrokers(r: Reader): OAuthBrokerConfig[] {
  const block = r.tree(OAUTH_BROKER_BLOCK.top);
  if (!block) return [];
  const out: OAuthBrokerConfig[] = [];
  for (const [name, value] of Object.entries(block)) {
    const base = `${OAUTH_BROKER_BLOCK.top}.${name}`;
    if (!isBrokerName(name)) {
      r.issues.add(base, OAUTH_BROKER_PROBLEMS.name, [`${OAUTH_BROKER_ENV_PREFIX}<NAME>_<FIELD>`]);
      continue;
    }
    if (!isPlainObject(value)) {
      r.issues.add(base, `expected a mapping of OAuth broker fields, got ${typeName(value)}`);
      continue;
    }
    const before = r.issues.items.length;
    const rawUrl = r.string(`${base}.url`, { required: true });
    const key = r.string(`${base}.key`, { required: true });
    let url: URL | undefined;
    if (rawUrl !== undefined) {
      const parsed = parseBrokerUrl(rawUrl);
      if (parsed.ok) url = parsed.url;
      else r.issues.add(`${base}.url`, parsed.problem, envNamesFor(`${base}.url`));
    }
    const providers = [...new Set(r.stringList(`${base}.providers`).map((p) => p.toLowerCase()))];
    for (const provider of providers) {
      if (!isBrokerProvider(provider)) {
        r.issues.add(
          `${base}.providers`,
          `${OAUTH_BROKER_PROBLEMS.provider}: "${provider}"`,
          envNamesFor(`${base}.providers`),
        );
      }
    }
    const attestation = parseBrokerAttestation(r.string(`${base}.attestation`));
    if (attestation === null) {
      r.issues.add(
        `${base}.attestation`,
        OAUTH_BROKER_PROBLEMS.attestation,
        envNamesFor(`${base}.attestation`),
      );
    } else if (attestation === 'required' && url?.protocol === 'http:') {
      r.issues.add(
        `${base}.url`,
        OAUTH_BROKER_PROBLEMS.attestedOverHttp,
        envNamesFor(`${base}.url`),
      );
    }
    if (r.issues.items.length > before || !url || !key || attestation === null) continue;
    out.push({ name, url, key, providers, attestation });
  }
  for (const problem of brokerSetProblems(out)) {
    r.issues.add(problem.path, problem.message, envNamesFor(problem.path));
  }
  return out;
}

/**
 * `mail.*`: the whole block or none of it. A host without a sender (or the reverse)
 * is an incomplete relay and refused by name; a user without a password likewise.
 */
function readMail(r: Reader): MailConfig | null {
  const host = r.string('mail.smtp_host')?.trim() || undefined;
  const from = r.string('mail.from')?.trim() || undefined;
  const user = r.string('mail.smtp_user')?.trim() || undefined;
  const password = r.string('mail.smtp_password') || undefined;
  const anySet =
    host !== undefined || from !== undefined || user !== undefined || password !== undefined;
  if (!anySet) return null;
  if (!host)
    r.issues.add(
      'mail.smtp_host',
      'required with the other mail.* keys',
      envNamesFor('mail.smtp_host'),
    );
  if (!from)
    r.issues.add(
      'mail.from',
      'required with the other mail.* keys: the sender address',
      envNamesFor('mail.from'),
    );
  if ((user === undefined) !== (password === undefined)) {
    r.issues.add(
      'mail.smtp_user',
      'set the user and the password together, or neither (a relay that takes mail without authentication)',
      [...envNamesFor('mail.smtp_user'), ...envNamesFor('mail.smtp_password')],
    );
  }
  if (from && !/^[^<>@\s]+@[^<>@\s]+$/.test(from) && !/^.+<[^<>@\s]+@[^<>@\s]+>$/.test(from)) {
    r.issues.add('mail.from', 'expected an address, or "Name <address>"', envNamesFor('mail.from'));
  }
  const port = r.int(keySpec('mail.smtp_port'));
  const tlsSpec = keySpec('mail.tls');
  const tls =
    r.string('mail.tls', { fallback: String(tlsSpec.default) }) ?? String(tlsSpec.default);
  if (!isMailTlsMode(tls)) {
    r.issues.add(
      'mail.tls',
      `expected one of ${MAIL_TLS_MODES.join(', ')}, got "${tls}"`,
      envNamesFor('mail.tls'),
    );
  }
  if (!host || !from || !isMailTlsMode(tls)) return null;
  return {
    smtpHost: host,
    smtpPort: port,
    smtpUser: user ?? null,
    smtpPassword: password ?? null,
    from,
    tls,
  };
}

/** The keys of the bucket: any one set asks for the required ones. */
const BACKUP_BUCKET_REQUIRED = [
  'backup.s3.endpoint',
  'backup.s3.region',
  'backup.s3.bucket',
  'backup.s3.access_key_id',
  'backup.s3.secret_access_key',
] as const;

/**
 * `backup.*` (ADR scheduled-encrypted-backup-to-object-storage, D1, D2): off when no
 * `backup.s3.*` key is set; otherwise the whole bucket block, a period of one hour to
 * a day that divides a day, and a time of day `HH:MM` (UTC). The secret is never quoted.
 */
function readBackup(r: Reader): BackupConfig | null {
  const s3Paths = [...BACKUP_BUCKET_REQUIRED, 'backup.s3.prefix', 'backup.s3.path_style'];
  if (!s3Paths.some((path) => r.has(path))) return null;
  const values = new Map<string, string>();
  for (const path of BACKUP_BUCKET_REQUIRED) {
    const value = r.string(path)?.trim();
    if (value) values.set(path, value);
    else
      r.issues.add(
        path,
        'required with the other backup.s3.* keys (endpoint, region, bucket, access key id and secret)',
        envNamesFor(path),
      );
  }
  const rawEndpoint = values.get('backup.s3.endpoint');
  let endpoint: URL | undefined;
  if (rawEndpoint !== undefined) {
    const parsed = parseBackupEndpoint(rawEndpoint);
    if (parsed.ok) endpoint = parsed.url;
    else r.issues.add('backup.s3.endpoint', parsed.problem, envNamesFor('backup.s3.endpoint'));
  }
  const bucket = values.get('backup.s3.bucket');
  if (bucket !== undefined && !isBucketName(bucket)) {
    r.issues.add(
      'backup.s3.bucket',
      'expected a bucket name: 3 to 63 lower-case letters, digits, dots and hyphens',
      envNamesFor('backup.s3.bucket'),
    );
  }
  const prefix = r.string('backup.s3.prefix')?.trim() ?? '';
  if (prefix.startsWith('/') || prefix.length > 512) {
    r.issues.add(
      'backup.s3.prefix',
      'must not start with "/" and must be at most 512 characters',
      envNamesFor('backup.s3.prefix'),
    );
  }
  const pathStyle = r.bool(keySpec('backup.s3.path_style'));
  const everySpec = keySpec('backup.every');
  const everySeconds = r.duration(everySpec);
  if (!isBackupPeriod(everySeconds)) {
    r.issues.add(
      everySpec.path,
      'expected a period from 1h to 24h that divides a day (1h, 2h, 3h, 4h, 6h, 8h, 12h, 24h)',
      envNamesFor(everySpec.path),
    );
  }
  const atSpec = keySpec('backup.at');
  const atText = r.text(atSpec);
  const atMinutes = parseTimeOfDay(atText);
  if (atMinutes === null) {
    r.issues.add(atSpec.path, `expected a time of day HH:MM (UTC), got "${atText}"`, [
      ...envNamesFor(atSpec.path),
    ]);
  }
  const keepSpec = keySpec('backup.keep');
  const keep = r.int(keepSpec);
  if (keep > keepSpec.max) {
    r.issues.add(keepSpec.path, `expected an integer from ${keepSpec.min} to ${keepSpec.max}`, [
      ...envNamesFor(keepSpec.path),
    ]);
  }
  const region = values.get('backup.s3.region');
  const accessKeyId = values.get('backup.s3.access_key_id');
  const secretAccessKey = r.string('backup.s3.secret_access_key');
  if (
    !endpoint ||
    !region ||
    !bucket ||
    !isBucketName(bucket) ||
    !accessKeyId ||
    !secretAccessKey ||
    atMinutes === null ||
    !isBackupPeriod(everySeconds)
  ) {
    return null;
  }
  return {
    s3: { endpoint, region, bucket, prefix, pathStyle, accessKeyId, secretAccessKey },
    everySeconds,
    atMinutes,
    keep: Math.min(keep, keepSpec.max),
  };
}

function readTelemetryLevel(r: Reader): TelemetryLevel {
  const fallback: TelemetryLevel = 'usage-stats';
  const level = r.string('telemetry.level', { fallback }) ?? fallback;
  if (isTelemetryLevel(level)) return level;
  r.issues.add(
    'telemetry.level',
    `expected one of ${TELEMETRY_LEVELS.join(', ')}, got "${level}"`,
    [...envNamesFor('telemetry.level')],
  );
  return fallback;
}

function readLogLevel(r: Reader): LogLevel {
  const level = r.string('log.level', { fallback: DEFAULT_LOG_LEVEL }) ?? DEFAULT_LOG_LEVEL;
  if (isLogLevel(level)) return level;
  r.issues.add('log.level', `expected one of ${LOG_LEVELS.join(', ')}, got "${level}"`, [
    ...envNamesFor('log.level'),
  ]);
  return DEFAULT_LOG_LEVEL;
}

/**
 * `encryption.*`. With `generate_master_key` the key must be a file (there is nothing
 * to write otherwise) and no restore may be configured (the copy needs *its* key, not
 * a new one). An absent key file the loader tolerates leaves `masterKey` empty: the
 * caller never hands that block to an encryptor (`loadInstanceConfigOrSetup`).
 */
function readEncryption(
  r: Reader,
  source: MasterKeySource,
  restoreConfigured: boolean,
): EncryptionConfig | null {
  const path = MASTER_KEY_PATH;
  const generateMasterKey = r.bool(keySpec(GENERATE_PATH));
  const acceptKeyBesideStore = r.bool(keySpec('encryption.accept_key_beside_store'));
  const absent = source.absent !== null;
  const encoded = absent ? undefined : r.string(path, { required: isKeyRequired(keySpec(path)) });
  const masterKey = encoded === undefined ? undefined : decodeKey(encoded, path, r.issues);
  const keyVersion = r.int(keySpec('encryption.key_version'));
  if (generateMasterKey && restoreConfigured) {
    r.issues.add(
      GENERATE_PATH,
      'cannot be set with restore.from: a restored copy opens with the key it was sealed with, not a new one',
      envNamesFor(GENERATE_PATH),
    );
  }
  if (generateMasterKey && source.file === null && encoded !== undefined) {
    r.issues.add(
      GENERATE_PATH,
      `applies to a key read from a file: name the file (${envNamesFor(path)[1] ?? ''} or \${file:…}) or unset this key`,
      envNamesFor(GENERATE_PATH),
    );
  }

  const previousKeys = new Map<number, Uint8Array>();
  const previous = r.tree('encryption.previous_keys');
  if (previous) {
    for (const [versionText, value] of Object.entries(previous)) {
      const subPath = `encryption.previous_keys.${versionText}`;
      const version = Number(versionText);
      if (!Number.isInteger(version) || version < 1) {
        r.issues.add(
          subPath,
          'version must be an integer >= 1',
          envNamesFor('encryption.previous_keys'),
        );
        continue;
      }
      if (version === keyVersion) {
        r.issues.add(subPath, `duplicates the current key_version ${keyVersion}`, [
          ...envNamesFor('encryption.previous_keys'),
        ]);
        continue;
      }
      if (typeof value !== 'string') {
        r.issues.add(subPath, `expected a base64 string, got ${typeName(value)}`, [
          ...envNamesFor('encryption.previous_keys'),
        ]);
        continue;
      }
      const key = decodeKey(value, subPath, r.issues);
      if (key) previousKeys.set(version, key);
    }
  }
  if (absent) {
    // Taken out again by the caller: a placeholder so the rest of the block is checked.
    return {
      masterKey: new Uint8Array(0),
      keyVersion,
      previousKeys,
      masterKeyFile: source.file,
      generateMasterKey,
      acceptKeyBesideStore,
    };
  }
  if (!masterKey) return null;
  return {
    masterKey,
    keyVersion,
    previousKeys,
    masterKeyFile: source.file,
    generateMasterKey,
    acceptKeyBesideStore,
  };
}

function decodeKey(encoded: string, path: string, issues: IssueList): Uint8Array | undefined {
  const trimmed = encoded.trim();
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length !== MASTER_KEY_BYTES || bytes.toString('base64') !== normalizeBase64(trimmed)) {
    issues.add(
      path,
      `must be ${MASTER_KEY_BYTES} random bytes encoded in base64 (generate one with \`npm run gen-master-key\`)`,
      envNamesFor(path),
    );
    return undefined;
  }
  return new Uint8Array(bytes);
}

function normalizeBase64(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return padded + '='.repeat((4 - (padded.length % 4)) % 4);
}

/**
 * The single-provider keys of earlier builds (`idp.*`, `VAUBAAN_IDP_*`) are refused:
 * ignored, they would leave the instance without the provider people sign in with.
 * The same provider is `sign_in.idp.*`, whose callback is `<public_url>/auth/callback/idp`
 * (gateway audit 2026-10-31, F7; CHANGELOG upgrade note).
 */
function refuseSingleProviderKeys(r: Reader, raw: RawTree, env: EnvSource): void {
  const variables = Object.keys(env)
    .filter((name) => name.startsWith(RETIRED_IDP_ENV_PREFIX) && env[name] !== undefined)
    .sort();
  if (raw[RETIRED_IDP_KEY] === undefined && variables.length === 0) return;
  r.issues.add(
    RETIRED_IDP_KEY,
    'the single-provider keys are retired: write the same provider as sign_in.idp.* (kind oidc, issuer, client_id, client_secret, claims, allowed_email_domains, invitation_only; VAUBAAN_SIGN_IN_IDP_KIND=oidc, VAUBAAN_SIGN_IN_IDP_ISSUER, …) and register <public_url>/auth/callback/idp at the identity provider',
    variables,
  );
}

/**
 * `sign_in.<id>.*`: one provider per id, in the order of the tree (the file's keys,
 * then the environment's). Every problem is named by its key.
 */
function readSignIn(r: Reader): SignInProvider[] {
  const block = r.tree('sign_in');
  if (!block) return [];
  const out: SignInProvider[] = [];
  for (const [id, value] of Object.entries(block)) {
    const base = `sign_in.${id}`;
    if (!isSignInProviderId(id)) {
      r.issues.add(
        base,
        'a sign-in provider id is a lower-case letter, then letters, digits or hyphens (at most 32)',
        [`${SIGN_IN_ENV_PREFIX}<ID>_<FIELD>`],
      );
      continue;
    }
    if (!isPlainObject(value)) {
      r.issues.add(base, `expected a mapping of sign-in provider fields, got ${typeName(value)}`);
      continue;
    }
    const provider = readSignInProvider(r, id, base);
    if (provider) out.push(provider);
  }
  return out;
}

function readSignInProvider(r: Reader, id: string, base: string): SignInProvider | null {
  const before = r.issues.items.length;
  const kind = r.string(`${base}.kind`, { required: true });
  if (kind !== undefined && !isSignInKind(kind)) {
    r.issues.add(
      `${base}.kind`,
      `expected one of ${SIGN_IN_KINDS.join(', ')}, got "${kind}"`,
      envNamesFor(`${base}.kind`),
    );
  }
  if (kind === 'local') {
    // Sign-in accounts: an id and a name. Nothing to register anywhere, nothing to admit by.
    for (const field of [
      'issuer',
      'client_id',
      'client_secret',
      'claims',
      'allowed_email_domains',
      'invitation_only',
      'require_verified_email',
    ]) {
      if (r.has(`${base}.${field}`)) {
        r.issues.add(
          `${base}.${field}`,
          `a local provider keeps the accounts itself: it has no ${field.replace(/_/g, ' ')} (it admits invited addresses and the admin rule's only)`,
          envNamesFor(`${base}.${field}`),
        );
      }
    }
    const name =
      r.string(`${base}.name`, { fallback: DEFAULT_LOCAL_PROVIDER_NAME }) ??
      DEFAULT_LOCAL_PROVIDER_NAME;
    if (r.issues.items.length > before) return null;
    return localProviderOf(id, name);
  }
  const clientId = r.string(`${base}.client_id`, { required: true });
  const clientSecret = r.string(`${base}.client_secret`, { required: true });
  const allowedEmailDomains = normalizeDomainsAt(r, `${base}.allowed_email_domains`);
  const invitationOnly = r.bool({ path: `${base}.invitation_only`, default: false });
  if (kind === 'github') {
    if (r.has(`${base}.require_verified_email`)) {
      r.issues.add(
        `${base}.require_verified_email`,
        'a GitHub provider admits the primary verified address only: the option does not apply',
        envNamesFor(`${base}.require_verified_email`),
      );
    }
    if (r.has(`${base}.claims`)) {
      r.issues.add(
        `${base}.claims`,
        'a GitHub provider has no claim mapping: the subject is the numeric user id and the email the primary verified address',
      );
    }
    const issuer = r.url(`${base}.issuer`, { fallback: GITHUB_DOT_COM, https: true });
    const name = r.string(`${base}.name`, { fallback: 'GitHub' }) ?? 'GitHub';
    if (issuer && (issuer.search || issuer.hash)) {
      r.issues.add(
        `${base}.issuer`,
        'must not carry a query string or fragment',
        envNamesFor(`${base}.issuer`),
      );
    }
    if (r.issues.items.length > before || !issuer || !clientId || !clientSecret) return null;
    return { kind, id, name, issuer, clientId, clientSecret, allowedEmailDomains, invitationOnly };
  }
  const issuer = r.url(`${base}.issuer`, { required: kind === 'oidc', https: true });
  if (issuer && (issuer.search || issuer.hash)) {
    r.issues.add(
      `${base}.issuer`,
      'must not carry a query string or fragment',
      envNamesFor(`${base}.issuer`),
    );
  }
  // A static check: the configuration never reaches the network at boot.
  if (issuer && isGithubDotComHost(issuer)) {
    r.issues.add(`${base}.issuer`, GITHUB_IS_NOT_OIDC, envNamesFor(`${base}.issuer`));
  }
  const claims = {
    sub: r.string(`${base}.claims.sub`, { fallback: 'sub' }) ?? 'sub',
    email: r.string(`${base}.claims.email`, { fallback: 'email' }) ?? 'email',
    groups: r.string(`${base}.claims.groups`, { fallback: 'groups' }) ?? 'groups',
    emailVerified:
      r.string(`${base}.claims.email_verified`, { fallback: 'email_verified' }) ?? 'email_verified',
  };
  const requireVerifiedEmail = r.bool({ path: `${base}.require_verified_email`, default: false });
  const name = r.string(`${base}.name`, { fallback: issuer?.hostname ?? id }) ?? id;
  if (kind !== 'oidc' || r.issues.items.length > before || !issuer || !clientId || !clientSecret) {
    return null;
  }
  return {
    kind,
    id,
    name,
    issuer,
    clientId,
    clientSecret,
    claims,
    allowedEmailDomains,
    invitationOnly,
    requireVerifiedEmail,
  };
}

function normalizeDomainsAt(r: Reader, path: string): string[] {
  const problems: string[] = [];
  const domains = normalizeEmailDomains(r.stringList(path), problems);
  for (const problem of problems) r.issues.add(path, problem, envNamesFor(path));
  return domains;
}

/**
 * The rules across the providers the configuration sets: one issuer each (a user is (issuer, subject): two providers
 * of one issuer would be one population with two admission rules), and an
 * admission rule for every open provider.
 */
function checkSignInProviders(r: Reader, signIn: readonly SignInProvider[]): SignInProvider[] {
  const all = [...signIn];
  const issuers = new Map<string, string>();
  const locals = all.filter((p) => p.kind === 'local');
  if (locals.length > 1) {
    r.issues.add(
      `sign_in.${locals[1]?.id ?? ''}.kind`,
      `providers '${locals.map((p) => p.id).join("', '")}' are all sign-in accounts: one local provider per instance`,
    );
  }
  for (const provider of all) {
    const path = `sign_in.${provider.id}`;
    const key = issuerKey(provider.issuer);
    const other = issuers.get(key);
    if (other !== undefined && other !== provider.id) {
      r.issues.add(
        `${path}.issuer`,
        `providers '${other}' and '${provider.id}' have the same issuer ${key}: a user is (issuer, subject), so they would be one population with two admission rules`,
        envNamesFor(`${path}.issuer`),
      );
    }
    issuers.set(key, provider.id);
    const problem = admissionProblem(provider);
    if (problem) {
      r.issues.add(`${path}.allowed_email_domains`, problem, [
        ...envNamesFor(`${path}.allowed_email_domains`),
        ...envNamesFor(`${path}.invitation_only`),
      ]);
    }
  }
  return all;
}

function readAdmin(r: Reader, signInProviders: readonly SignInProvider[]): AdminRule {
  const group = r.string('admin.group') ?? null;
  const emails = r.stringList('admin.emails').map((e) => e.toLowerCase());
  for (const email of emails) {
    if (!email.includes('@')) {
      r.issues.add(
        'admin.emails',
        `"${email}" is not an email address`,
        envNamesFor('admin.emails'),
      );
    }
  }
  const groupProblem =
    signInProviders.length > 1
      ? adminGroupProblem(
          group,
          signInProviders.map((p) => p.id),
        )
      : null;
  if (groupProblem) r.issues.add('admin.group', groupProblem, envNamesFor('admin.group'));
  // Optional: a seed the boot applies while the store names no administrator (ADR
  // administrators-live-in-the-instance). Without one the setup names the first.
  return { group, emails };
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'a mapping' : `a ${typeof value}`;
}

function show(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}
