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
import { installedClients } from './installed-clients';

import { readEnvSource } from './env-source';
import { ConfigError, IssueList } from './errors';
import { readFileSource } from './file-source';
import { localModeAsked, withLocalPresets } from './local-mode';
import {
  masterKeySource,
  MASTER_KEY_PATH,
  readEncryption,
  type MasterKeySource,
} from './master-key';
import { readBackup, readRestore } from './read-backup';
import { readMail } from './read-mail';
import {
  readClientIpHeader,
  readInstanceName,
  readPublicUrl,
  readTrustedProxies,
  requireAddressSource,
} from './read-network';
import {
  readDocs,
  readLogLevel,
  readLimits,
  refuseRetiredLimitKeys,
  readOpsToken,
  readRefreshInterval,
  readTelemetryLevel,
  readUpdates,
} from './read-operations';
import { readOAuthBrokers, readPlugins } from './read-plugins';
import {
  checkSignInProviders,
  readAdmin,
  readBootstrapToken,
  readSignIn,
  refuseSingleSignInProviderKeys,
} from './read-sign-in';
import { BYTES_PER_MEGABYTE, Reader } from './reader';
import { retiredConfigKeys, retiredManagementKeys } from './retired-keys';
import {
  type AbsentSecretFile,
  type EnvSource,
  type FileReader,
  defaultFileReader,
  newSourceTrace,
} from './secret-refs';
import { readSelfResources } from './self-resources';
import { envNamesFor, isKeyRequired, keySpec, secretEnvVariables } from './sources';
import { getPath, mergeTrees, type RawTree } from './tree';
import type { AbsentMasterKeyReason, InstanceConfig, SetupConfig } from './types';

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

  const fromFile = readFileSource(env, issues, readFile, fileTrace);
  // Local mode supplies its keys as the variables a person would have set (local-mode.ts).
  const local = localModeAsked(env, fromFile?.tree ?? null);
  const effectiveEnv = local ? withLocalPresets(env, fromFile?.tree ?? null) : env;
  const fromEnv = readEnvSource(effectiveEnv, issues, readFile, envTrace);
  const raw = fromFile ? mergeTrees(fromEnv, fromFile.tree) : fromEnv;
  const masterKey = masterKeySource(raw, fromFile?.tree ?? null, envTrace, fileTrace, issues);
  const validated = validate(raw, issues, effectiveEnv, masterKey);
  const config = validated;
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

function validate(
  raw: RawTree,
  issues: IssueList,
  env: EnvSource,
  masterKey: MasterKeySource,
): InstanceConfig | null {
  const r = new Reader(raw, issues);
  const before = issues.items.length;

  const local = r.bool(keySpec('local'));
  const publicUrl = readPublicUrl(r, local);
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
  refuseSingleSignInProviderKeys(r, raw, env);
  const signIn = readSignIn(r);
  const signInProviders = checkSignInProviders(r, signIn);
  const admin = readAdmin(r, signInProviders);
  const bootstrapToken = readBootstrapToken(r, signInProviders.length > 0, local);
  refuseRetiredLimitKeys(r, raw, env);
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
  const refreshIntervalSeconds = readRefreshInterval(r, raw);
  const oauthBrokers = readOAuthBrokers(r);
  const level = readLogLevel(r);

  if (issues.items.length > before) return null;
  if (!publicUrl || !storePath || !encryption || !collectorUrl || !updates || !docs) return null;
  // An absent key file the boot tolerates: the block is complete but for the key
  // itself, which the caller takes out again (`SetupOutcome`).

  return {
    local,
    installedClients: local ? installedClients() : [],
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
    accounts: { refreshIntervalSeconds },
    limits,
    ops: { token: opsToken },
    plugins,
    updates,
    docs,
    oauthBrokers,
    log: { level },
  };
}
