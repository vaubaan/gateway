/**
 * What the boot says and checks before the modules are wired: the configuration's
 * summary, the warnings about the edge and the key file, the retired keys, and whether
 * the configured master keys open what the store holds. Called by `buildRoot` (`root.ts`).
 */
import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import type { Store } from '../store';
import {
  KEY_BESIDE_STORE_WARNING,
  keyBesideStore,
  PROCESS_MOUNT_FACTS,
  type MountFacts,
} from './key-placement';

/**
 * Whether the configured master keys open what the store holds: one blob per table and
 * key version is opened at boot. A version with no configured key, or whose key does
 * not fit (a new key set without raising its version), is logged at `error`, once per
 * version, naming the keys to fix. The instance still starts: what it cannot open fails
 * call by call, and the operator needs the instance up to see it (ADR
 * master-key-rotation-reseals-every-blob, amendment).
 */
export const SEALED_KEY_MISMATCH =
  'stored secrets do not open with the configured master keys: fix VAUBAAN_MASTER_KEY / VAUBAAN_MASTER_KEY_VERSION / VAUBAAN_MASTER_KEY_PREVIOUS and redeploy';

export async function checkSealedKeys(
  store: Store,
  config: InstanceConfig,
  logger: Logger,
): Promise<void> {
  const failing = (await store.sealedBlobs.probe()).filter((p) => !p.opens);
  const versions = [...new Set(failing.map((p) => p.keyVersion))].sort((a, b) => a - b);
  for (const version of versions) {
    const configured =
      version === config.encryption.keyVersion || config.encryption.previousKeys.has(version);
    logger.error(SEALED_KEY_MISMATCH, {
      key_version: version,
      current_key_version: config.encryption.keyVersion,
      cause: configured
        ? 'a key is configured for this version but it is not the one that sealed these blobs'
        : 'no key is configured for this version',
      blobs: failing.filter((p) => p.keyVersion === version).map((p) => `${p.table}: ${p.count}`),
    });
  }
}

export function logConfigurationSummary(
  logger: Logger,
  config: InstanceConfig,
  configFile: string | null,
): void {
  const opsStats =
    config.ops.token === null ? 'off (no ops.token)' : 'open to the bearer of ops.token';
  logger.info('configuration loaded', {
    source: configFile ? `file ${configFile} over environment` : 'environment',
    public_url: config.publicUrl.origin,
    instance_name: config.instanceName ?? 'not set (Administration decides; the host by default)',
    sign_in: config.signIn.map((signInProvider) => `${signInProvider.id} (${signInProvider.kind})`),
    admin_rule:
      config.admin.group === null && config.admin.emails.length === 0
        ? 'none (administrators live in the instance)'
        : config.admin.group
          ? 'group (a seed: applied while the store names nobody)'
          : `emails (${config.admin.emails.length}; a seed: applied while the store names nobody)`,
    telemetry: !config.telemetry.enabledSetByConfig
      ? 'not set (Administration decides; off by default)'
      : config.telemetry.enabled
        ? 'enabled'
        : 'disabled',
    key_version: config.encryption.keyVersion,
    trusted_proxies: config.trustedProxies.length,
    client_ip_header: config.clientIpHeader ?? 'not set',
    limits: {
      users: config.limits.users ?? 'unlimited',
      accounts: config.limits.accounts ?? 'unlimited',
      active_missions: config.limits.activeMissions ?? 'unlimited',
    },
    ops_stats: opsStats,
  });
  warnWithoutTrustedProxies(logger, config);
}

/**
 * The instance always sits behind a TLS terminator, so every request reaches it from
 * that proxy: with `trusted_proxies` empty no client address is believed, and every
 * limit keyed on the address is one window shared by all callers. Nothing is bypassed
 * (a forged `X-Forwarded-For` is ignored), but one caller can then hold the others at
 * 429: anybody signed out on the request page and sign-in.
 * Said once at boot, naming the key.
 */
export const NO_TRUSTED_PROXY_WARNING =
  'trusted_proxies is empty: no client address is resolved, so the address-keyed limits are shared by all callers';

/** Trusted-edge mode is a statement about the edge: said once at boot, with what it rests on. */
export const EDGE_HEADER_NOTICE =
  'client_ip_header is set: the client address is read from that header alone, which is safe only behind an edge that overwrites it on every request';

function warnWithoutTrustedProxies(logger: Logger, config: InstanceConfig): void {
  if (config.clientIpHeader !== null) {
    logger.warn(EDGE_HEADER_NOTICE, {
      key: 'client_ip_header',
      env: 'VAUBAAN_CLIENT_IP_HEADER',
      header: config.clientIpHeader,
      check:
        'send a request with a forged value of this header and confirm the instance sees your real address (deploy/railway.md)',
    });
    return;
  }
  if (config.trustedProxies.length > 0) return;
  logger.warn(NO_TRUSTED_PROXY_WARNING, {
    key: 'trusted_proxies',
    env: 'VAUBAAN_TRUSTED_PROXIES',
    affected: [
      'request page: one per-IP window for everybody',
      'sign-in and bootstrap: one window for everybody (one caller can hold the others at 429)',
      'audit: client_ip is not recorded',
    ],
    remedy:
      'set it to the address or CIDR block of the reverse proxy in front of the instance (deploy/README.md), or, behind an edge that overwrites a client-address header (Railway: X-Real-IP), set client_ip_header',
  });
}

/**
 * The key file on the store's mount: one copy of the volume opens every credential
 * (ADR master-key-generated-and-handed-over-by-the-instance, amendment 2026-10-31).
 * Said once at boot, unless the operator accepted it; nothing is said when the key is
 * given by value or the placement cannot be told.
 */
export function warnKeyBesideStore(
  logger: Logger,
  config: InstanceConfig,
  facts: MountFacts = PROCESS_MOUNT_FACTS,
): void {
  const keyFile = config.encryption.masterKeyFile;
  if (keyFile === null || config.encryption.acceptKeyBesideStore) return;
  if (keyBesideStore(keyFile, config.store.path, facts) !== true) return;
  logger.warn(KEY_BESIDE_STORE_WARNING, {
    key_file: keyFile,
    store_path: config.store.path,
    remedy:
      'mount the key on a volume of its own (deploy/compose.yaml mounts gateway-key at /keys), or give it as a secret (VAUBAAN_MASTER_KEY_FILE=/run/secrets/…); keep a copy off the host',
    accept:
      'VAUBAAN_ACCEPT_KEY_BESIDE_STORE=1 when the volume’s snapshots are kept apart from the key',
  });
}

/**
 * One warning per retired key or variable the configuration still sets: the
 * OAuth clients an administrator declared per provider (`providers.<id>.*`,
 * `VAUBAAN_PROVIDER_<ID>_<FIELD>`) are no longer read since Gmail connects with
 * an app password (ADR gmail-over-imap-with-an-app-password). The instance
 * starts; the value is never logged.
 */
export function logRetiredKeys(
  config: Pick<InstanceConfig, 'retiredKeys' | 'retiredManagementKeys' | 'deprecatedKeys'>,
  logger: Logger,
): void {
  for (const { old, current } of config.deprecatedKeys) {
    logger.warn(DEPRECATED_KEY_WARNING, { key: old, write_instead: current });
  }
  for (const key of config.retiredKeys) {
    logger.warn(
      'configuration key no longer read: the gateway takes no OAuth client declared by an administrator (Gmail connects with an app password); remove it',
      { key },
    );
  }
  // One line for the whole retired block (ADR platform-management-is-a-plugin-on-the-execution-door).
  if (config.retiredManagementKeys.length > 0) {
    logger.warn(RETIRED_MANAGEMENT_KEYS_WARNING, { keys: [...config.retiredManagementKeys] });
  }
}

/** Said once per renamed key or variable the configuration still uses under its old name. */
export const DEPRECATED_KEY_WARNING =
  'configuration key renamed: it is still read under its old name, for now; write the new one';

/** Said once at boot when the configuration still sets keys of the retired authorization server. */
export const RETIRED_MANAGEMENT_KEYS_WARNING =
  'configuration keys no longer read: the gateway runs no OAuth authorization server any more (agents prepare missions through the Vaubaan account and a mission key); remove them';
