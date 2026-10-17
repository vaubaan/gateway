/**
 * The configuration of a boot (ADR master-key-generated-and-handed-over-by-the-instance).
 *
 * `loadProcessConfig()` with one more outcome: when the configuration names the
 * master key as a file that does not exist and `encryption.generate_master_key`
 * is on, the key is generated here — 32 random bytes, base64, mode 0600 — and
 * the configuration is loaded again with it. Nothing is generated when the
 * store already holds data: a key missing on an existing store is a
 * configuration error, never a reason to mint a new key. Without the opt-in the
 * behaviour is the loader's: a missing key is an error (exit 78).
 *
 * One more outcome for the boot alone (`loadBootConfigOrSetup`): the key file is
 * absent, `restore.from` is set and the store is empty — the instance starts in
 * setup mode and the setup page receives the key (`server/setup/`).
 *
 * The operator commands (`reseal`, `restore`, `backup`, `import-v4`) keep
 * `loadProcessConfig()`: they never generate anything.
 */
import {
  ConfigError,
  envNamesFor,
  errorMessage,
  loadInstanceConfigOrSetup,
  scrubSecretEnv,
  type LoadedConfig,
  type LoadOptions,
  type SetupOutcome,
} from '../config';
import type { EnvSource } from '../config/secret-refs';
import {
  generateMasterKeyText,
  writeMasterKeyFile,
  type MasterKeyFileWriter,
} from '../crypto/master-key-file';
import { storeHasContent } from '../restore/restore';

export interface BootConfigDeps extends LoadOptions {
  /** Tests: whether the store at `store.path` already holds data. */
  readonly storeHasContent?: (path: string) => boolean;
  /** Tests: the key file writer. */
  readonly writeKeyFile?: MasterKeyFileWriter;
  /** Tests: the key text (base64, newline). */
  readonly generateKey?: () => string;
  /** Whether to delete the secret variables from `env` once loaded (the process: yes). */
  readonly scrub?: boolean;
}

const MASTER_KEY_PATH = 'encryption.master_key';

/**
 * What a boot starts from: a configuration, or setup mode — the key file is absent,
 * a restore is configured, the store is empty — with the environment the final
 * load will read once the key arrives (`process.env` itself has been scrubbed).
 */
export type BootConfigOutcome =
  | { readonly kind: 'ready'; readonly loaded: LoadedConfig }
  | { readonly kind: 'setup'; readonly setup: SetupOutcome; readonly env: EnvSource };

export function loadBootConfig(deps: BootConfigDeps = {}): LoadedConfig {
  const outcome = loadBootConfigOrSetup(deps);
  if (outcome.kind === 'ready') return outcome.loaded;
  // A restore without the key of the copy: the boot has no key to verify it with.
  throw new ConfigError([
    {
      path: MASTER_KEY_PATH,
      env: outcome.setup.issue.env,
      message: `${outcome.setup.issue.message} (a restore needs the key the copy was sealed with; put the file back)`,
    },
  ]);
}

export function loadBootConfigOrSetup(deps: BootConfigDeps = {}): BootConfigOutcome {
  const env = deps.env ?? process.env;
  const options: LoadOptions = { env, readFile: deps.readFile };
  const outcome = loadInstanceConfigOrSetup(options);
  if (outcome.kind === 'ready') {
    return { kind: 'ready', loaded: finish(outcome.loaded, env, deps.scrub ?? true, false) };
  }

  const envNames = envNamesFor(MASTER_KEY_PATH).slice(1);
  if (outcome.reason !== 'generate') {
    if ((deps.storeHasContent ?? storeHasContent)(outcome.config.store.path)) {
      throw new ConfigError([
        {
          path: MASTER_KEY_PATH,
          env: outcome.issue.env,
          message: `${outcome.issue.message} (the store already holds data: put the key file back)`,
        },
      ]);
    }
    // Setup mode: the final load reads a snapshot of the environment, so the
    // process's own can be scrubbed now (ADR secrets-leave-the-process-environment-after-load).
    const snapshot: Record<string, string | undefined> = { ...env };
    if (deps.scrub ?? true) scrubSecretEnv(env, outcome.secretEnvNames);
    return { kind: 'setup', setup: outcome, env: snapshot };
  }
  const { masterKeyFile: path } = outcome;
  const storePath = outcome.config.store.path;
  if ((deps.storeHasContent ?? storeHasContent)(storePath)) {
    throw new ConfigError([
      {
        path: MASTER_KEY_PATH,
        env: envNames,
        message:
          `the key file "${path}" does not exist, and the store at '${storePath}' already holds data: ` +
          'a key missing on an existing store is a configuration error, never a reason to generate a new one (put the key file back)',
      },
    ]);
  }
  try {
    (deps.writeKeyFile ?? writeMasterKeyFile)(path, (deps.generateKey ?? generateMasterKeyText)());
  } catch (err) {
    throw new ConfigError([
      {
        path: MASTER_KEY_PATH,
        env: envNames,
        message: `cannot write the generated key file "${path}": ${errorMessage(err)}`,
      },
    ]);
  }
  const again = loadInstanceConfigOrSetup(options);
  if (again.kind !== 'ready') {
    // Unreachable in practice: the file was just written. Never silently setup.
    throw new ConfigError([
      {
        path: MASTER_KEY_PATH,
        env: envNames,
        message: `the key file "${path}" was written but cannot be read back`,
      },
    ]);
  }
  return { kind: 'ready', loaded: finish(again.loaded, env, deps.scrub ?? true, true) };
}

function finish(
  loaded: LoadedConfig,
  env: Record<string, string | undefined>,
  scrub: boolean,
  generated: boolean,
): LoadedConfig {
  if (scrub) scrubSecretEnv(env, loaded.secretEnvNames);
  return generated ? { ...loaded, masterKeyGenerated: true } : loaded;
}
