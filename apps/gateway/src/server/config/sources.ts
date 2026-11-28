/**
 * The configuration keys. The two sources (`readEnvSource()` in `env-source.ts`,
 * `readFileSource()` in `file-source.ts`) both produce the same raw tree shaped
 * like `deploy/config/gateway.example.yaml`.
 *
 * `KEYS` is the single table of configuration keys: YAML path, environment
 * variable, how the variable is parsed, and the defaults and bounds the loader
 * applies (`load.ts` and its `read-*.ts` modules read them from here, they hold no
 * second copy). The handbook table and the example files are derived from it,
 * never the other way round; `keys-doc.test.ts` holds the handbook to it.
 */
import { TELEMETRY_LEVELS } from '@vaubaan/telemetry';
import { CLIENT_IP_HEADERS } from '../http/client-ip';

import { NAMED_BLOCKS, namedBlockEnvName, parseNamedBlockEnvName } from './named-blocks';
import type { NamedBlock, NamedBlockField } from './named-blocks';
import { RETIRED_PROVIDER_ENV_PREFIX, RETIRED_PROVIDERS_KEY } from './retired-keys';
import type { EnvSource } from './secret-refs';
import { INSTANCE_NAME_MAX_LENGTH } from './instance-name';
import { DEFAULT_TELEMETRY_COLLECTOR_URL } from './telemetry-default';
import { DEFAULT_DOCS_URL } from './docs-default';
import { DEFAULT_UPDATES_FEED_URL } from './updates-default';
import { LOG_LEVELS, MAIL_TLS_MODES } from './types';

export type KeyKind = 'string' | 'secret' | 'list' | 'int' | 'bool' | 'secret-map';

/** What a `string` key holds when it is more than free text. */
export type KeyFormat = 'url' | 'duration' | 'enum';

/**
 * When a key must be set: always, or as long as the configuration sets no sign-in
 * provider (`sign_in.<id>.*`) at all (`without-sign-in`).
 */
export type KeyRequirement = 'always' | 'without-sign-in';

export interface KeySpec {
  readonly path: string;
  readonly env: string;
  readonly kind: KeyKind;
  readonly format?: KeyFormat;
  /** Used when neither source sets the key; a duration is written as in the file. */
  readonly default?: string | number | boolean;
  readonly required?: KeyRequirement;
  /** Lowest and highest integer accepted (`int` keys). */
  readonly min?: number;
  readonly max?: number;
  /** Longest duration accepted, in seconds (`duration` keys). */
  readonly maxSeconds?: number;
  /** The values an `enum` key accepts. */
  readonly oneOf?: readonly string[];
  /** A `url` key that must use https. */
  readonly https?: boolean;
  /** Shortest value accepted, in characters. */
  readonly minLength?: number;
  /** Longest value accepted, in characters. */
  readonly maxLength?: number;
}

export const CONFIG_FILE_ENV = 'VAUBAAN_CONFIG_FILE';

const KEY_TABLE = [
  {
    path: 'public_url',
    env: 'VAUBAAN_PUBLIC_URL',
    kind: 'string',
    format: 'url',
    required: 'always',
    https: true,
  },
  // Local mode (ADR local-mode-for-an-instance-on-this-computer): an instance for the
  // computer it runs on. It is the only way an http public URL is accepted, on a loopback
  // host only, and it supplies the keys a person on a laptop cannot decide (LOCAL_PRESETS).
  { path: 'local', env: 'VAUBAAN_LOCAL', kind: 'bool', default: false },
  {
    path: 'instance_name',
    env: 'VAUBAAN_INSTANCE_NAME',
    kind: 'string',
    minLength: 1,
    maxLength: INSTANCE_NAME_MAX_LENGTH,
  },
  { path: 'trusted_proxies', env: 'VAUBAAN_TRUSTED_PROXIES', kind: 'list' },
  { path: 'self_resources', env: 'VAUBAAN_SELF_RESOURCES', kind: 'list' },
  {
    path: 'client_ip_header',
    env: 'VAUBAAN_CLIENT_IP_HEADER',
    kind: 'string',
    format: 'enum',
    oneOf: CLIENT_IP_HEADERS,
  },
  // In production a source of client addresses is required (one of the two keys above);
  // this says the operator accepts address windows shared by every caller instead.
  {
    path: 'accept_shared_address_windows',
    env: 'VAUBAAN_ACCEPT_SHARED_ADDRESS_WINDOWS',
    kind: 'bool',
    default: false,
  },
  { path: 'store.path', env: 'VAUBAAN_STORE_PATH', kind: 'string', required: 'always' },
  // A presigned URL is a credential: `restore.from` is a secret (see
  // docs/handbook/store.md).
  { path: 'restore.from', env: 'VAUBAAN_RESTORE_FROM', kind: 'secret' },
  { path: 'restore.sha256', env: 'VAUBAAN_RESTORE_SHA256', kind: 'string' },
  {
    path: 'restore.max_mb',
    env: 'VAUBAAN_RESTORE_MAX_MB',
    kind: 'int',
    default: 1024,
    min: 1,
    max: 65_536,
  },
  {
    path: 'encryption.master_key',
    env: 'VAUBAAN_MASTER_KEY',
    kind: 'secret',
    required: 'always',
  },
  {
    path: 'encryption.key_version',
    env: 'VAUBAAN_MASTER_KEY_VERSION',
    kind: 'int',
    default: 1,
    min: 1,
  },
  { path: 'encryption.previous_keys', env: 'VAUBAAN_MASTER_KEY_PREVIOUS', kind: 'secret-map' },
  // The key generated at the first start when its file is absent (ADR
  // master-key-generated-and-handed-over-by-the-instance).
  {
    path: 'encryption.generate_master_key',
    env: 'VAUBAAN_MASTER_KEY_GENERATE',
    kind: 'bool',
    default: false,
  },
  // The boot warns when the key file and the store share a mount (a snapshot of the
  // volume holds both); the operator who keeps the volume's copies apart says so here.
  {
    path: 'encryption.accept_key_beside_store',
    env: 'VAUBAAN_ACCEPT_KEY_BESIDE_STORE',
    kind: 'bool',
    default: false,
  },
  { path: 'admin.group', env: 'VAUBAAN_ADMIN_GROUP', kind: 'string' },
  { path: 'admin.emails', env: 'VAUBAAN_ADMIN_EMAILS', kind: 'list' },
  {
    path: 'bootstrap_token',
    env: 'VAUBAAN_BOOTSTRAP_TOKEN',
    kind: 'secret',
    required: 'without-sign-in',
    minLength: 32,
  },
  // Mail delivery (ADR local-accounts-sign-in-provider, D6): the relay through which the
  // instance sends its own mail — the links of the sign-in accounts. Optional as a block:
  // set the host and the sender, or neither.
  { path: 'mail.smtp_host', env: 'VAUBAAN_MAIL_SMTP_HOST', kind: 'string' },
  {
    path: 'mail.smtp_port',
    env: 'VAUBAAN_MAIL_SMTP_PORT',
    kind: 'int',
    default: 587,
    min: 1,
    max: 65_535,
  },
  { path: 'mail.smtp_user', env: 'VAUBAAN_MAIL_SMTP_USER', kind: 'string' },
  { path: 'mail.smtp_password', env: 'VAUBAAN_MAIL_SMTP_PASSWORD', kind: 'secret' },
  { path: 'mail.from', env: 'VAUBAAN_MAIL_FROM', kind: 'string' },
  {
    path: 'mail.tls',
    env: 'VAUBAAN_MAIL_TLS',
    kind: 'string',
    format: 'enum',
    default: 'starttls',
    oneOf: MAIL_TLS_MODES,
  },
  // Scheduled, encrypted backup to S3-compatible storage (ADR
  // scheduled-encrypted-backup-to-object-storage): off unless `backup.s3.*` is set,
  // and then the whole block (endpoint, region, bucket, access key id, secret).
  { path: 'backup.s3.endpoint', env: 'VAUBAAN_BACKUP_S3_ENDPOINT', kind: 'string', format: 'url' },
  { path: 'backup.s3.region', env: 'VAUBAAN_BACKUP_S3_REGION', kind: 'string' },
  { path: 'backup.s3.bucket', env: 'VAUBAAN_BACKUP_S3_BUCKET', kind: 'string' },
  { path: 'backup.s3.prefix', env: 'VAUBAAN_BACKUP_S3_PREFIX', kind: 'string' },
  {
    path: 'backup.s3.path_style',
    env: 'VAUBAAN_BACKUP_S3_PATH_STYLE',
    kind: 'bool',
    default: false,
  },
  { path: 'backup.s3.access_key_id', env: 'VAUBAAN_BACKUP_S3_ACCESS_KEY_ID', kind: 'string' },
  {
    path: 'backup.s3.secret_access_key',
    env: 'VAUBAAN_BACKUP_S3_SECRET_ACCESS_KEY',
    kind: 'secret',
  },
  {
    path: 'backup.every',
    env: 'VAUBAAN_BACKUP_EVERY',
    kind: 'string',
    format: 'duration',
    default: '24h',
    maxSeconds: 86_400,
  },
  { path: 'backup.at', env: 'VAUBAAN_BACKUP_AT', kind: 'string', default: '03:00' },
  {
    path: 'backup.keep',
    env: 'VAUBAAN_BACKUP_KEEP',
    kind: 'int',
    default: 0,
    min: 0,
    max: 10_000,
  },
  { path: 'telemetry.enabled', env: 'VAUBAAN_TELEMETRY_ENABLED', kind: 'bool', default: false },
  {
    path: 'telemetry.level',
    env: 'VAUBAAN_TELEMETRY_LEVEL',
    kind: 'string',
    format: 'enum',
    default: 'usage-stats',
    oneOf: TELEMETRY_LEVELS,
  },
  {
    path: 'telemetry.collector_url',
    env: 'VAUBAAN_TELEMETRY_COLLECTOR_URL',
    kind: 'string',
    format: 'url',
    default: DEFAULT_TELEMETRY_COLLECTOR_URL,
    https: true,
  },
  { path: 'retention_days', env: 'VAUBAAN_RETENTION_DAYS', kind: 'int', default: 90, min: 1 },
  {
    path: 'requests.expiry',
    env: 'VAUBAAN_REQUEST_EXPIRY',
    kind: 'string',
    format: 'duration',
    default: '24h',
  },
  // Trust-raise proposals (risk model §4.7): granted approvals on one macro-action of
  // one resource set, with no refusal since its trust level changed, before a raise is
  // offered to the creator.
  {
    path: 'trust_raise.after_approvals',
    env: 'VAUBAAN_TRUST_RAISE_AFTER_APPROVALS',
    kind: 'int',
    default: 10,
    min: 1,
  },
  {
    path: 'approvals.expiry',
    env: 'VAUBAAN_APPROVAL_EXPIRY',
    kind: 'string',
    format: 'duration',
    default: '10m',
  },
  {
    path: 'mcp.rate_limit_per_minute',
    env: 'VAUBAAN_MCP_RATE_LIMIT_PER_MINUTE',
    kind: 'int',
    default: 600,
    min: 1,
  },
  // The deadline of one plugin call on the execution door (`execution/upstream-stage.ts`):
  // a service that never answers releases the request, the credential and the slot.
  {
    path: 'execution.call_timeout_seconds',
    env: 'VAUBAAN_EXECUTION_CALL_TIMEOUT_SECONDS',
    kind: 'int',
    default: 120,
    min: 1,
  },
  {
    path: 'git.max_pack_mb',
    env: 'VAUBAAN_GIT_MAX_PACK_MB',
    kind: 'int',
    default: 200,
    min: 1,
    max: 4096,
  },
  {
    path: 'git.request_timeout',
    env: 'VAUBAAN_GIT_REQUEST_TIMEOUT',
    kind: 'string',
    format: 'duration',
    default: '10m',
    maxSeconds: 3_600,
  },
  // The automatic refresh of the accounts (spec §0 "Resource"): hourly by default, `0` off.
  {
    path: 'accounts.refresh_interval',
    env: 'VAUBAAN_ACCOUNTS_REFRESH_INTERVAL',
    kind: 'string',
    format: 'duration',
    default: '1h',
    maxSeconds: 86_400,
  },
  // Ceilings (spec §4.3 bis): absent is unlimited, the default. Enforced where an
  // item would be added, never by cutting (`server/limits`).
  { path: 'limits.users', env: 'VAUBAAN_LIMITS_USERS', kind: 'int', min: 1 },
  { path: 'limits.accounts', env: 'VAUBAAN_LIMITS_ACCOUNTS', kind: 'int', min: 1 },
  {
    path: 'limits.active_missions',
    env: 'VAUBAAN_LIMITS_ACTIVE_MISSIONS',
    kind: 'int',
    min: 1,
  },
  // Plugins pinned by the operator and the plugins registered (ADR
  // plugins-bundled-or-pinned-by-the-operator). No default directory: the image sets
  // `VAUBAAN_PLUGINS_DIR=/plugins`, elsewhere nothing is pinned unless configured.
  { path: 'plugins.dir', env: 'VAUBAAN_PLUGINS_DIR', kind: 'string' },
  { path: 'plugins.enabled', env: 'VAUBAAN_PLUGINS_ENABLED', kind: 'list' },
  // The ids an administrator may install without a signature (ADR
  // plugin-signature-sets-the-trust-level): no interface sets them.
  { path: 'plugins.allow_unsigned', env: 'VAUBAAN_PLUGINS_ALLOW_UNSIGNED', kind: 'list' },
  // A start with the image's versions only, ignoring what was installed (ADR
  // plugins-activated-by-an-administrator-on-trial): the way back without the interface.
  { path: 'plugins.safe_mode', env: 'VAUBAAN_PLUGINS_SAFE_MODE', kind: 'bool', default: false },
  // What plugins may reach besides the public internet (ADR
  // plugins-reach-the-public-internet-only): an internal CalDAV server, a self-hosted API.
  { path: 'plugins.private_hosts', env: 'VAUBAAN_PLUGINS_PRIVATE_HOSTS', kind: 'list' },
  // The published versions feed, read at start and daily; a GET carrying nothing
  // about the instance (`server/updates`).
  { path: 'updates.check', env: 'VAUBAAN_UPDATES_CHECK', kind: 'bool', default: true },
  {
    path: 'updates.feed_url',
    env: 'VAUBAAN_UPDATES_FEED_URL',
    kind: 'string',
    format: 'url',
    default: DEFAULT_UPDATES_FEED_URL,
    https: true,
  },
  // The user docs the (i) of each page opens in a new tab; never requested by the instance.
  {
    path: 'docs.url',
    env: 'VAUBAAN_DOCS_URL',
    kind: 'string',
    format: 'url',
    default: DEFAULT_DOCS_URL,
    https: true,
  },
  // The bearer of `GET /ops/stats` (spec §4.3 bis): absent, the endpoint does not exist.
  { path: 'ops.token', env: 'VAUBAAN_OPS_TOKEN', kind: 'secret', minLength: 32 },
  {
    path: 'log.level',
    env: 'VAUBAAN_LOG_LEVEL',
    kind: 'string',
    format: 'enum',
    default: 'info',
    oneOf: LOG_LEVELS,
  },
] as const satisfies readonly KeySpec[];

type KeyEntry = (typeof KEY_TABLE)[number];
export type KeyPath = KeyEntry['path'];

export const KEYS: readonly KeySpec[] = KEY_TABLE;

/** The entry of one key, with its literal default and bounds. */
export function keySpec<P extends KeyPath>(path: P): Extract<KeyEntry, { readonly path: P }> {
  const spec = KEY_TABLE.find((k) => k.path === path);
  if (!spec) throw new Error(`unknown configuration key ${path}`); // unreachable: P is a path of the table
  return spec as Extract<KeyEntry, { readonly path: P }>;
}

/**
 * Whether a key must be set. `signInConfigured` says whether the configuration sets
 * a sign-in provider; it only matters to the keys whose requirement depends on it.
 */
export function isKeyRequired(spec: KeySpec, signInConfigured?: boolean): boolean {
  switch (spec.required) {
    case 'always':
      return true;
    case 'without-sign-in':
      return signInConfigured === false;
    case undefined:
      return false;
  }
}

/** Environment variable names that set a given YAML path (for error messages). */
export function envNamesFor(path: string): string[] {
  const named = namedFieldOf(path);
  if (named) {
    if (!named.spec) return [];
    const name = namedBlockEnvName(named.block, named.name, named.spec.env);
    return named.spec.kind === 'secret' ? [name, `${name}_FILE`] : [name];
  }
  const spec = KEYS.find((k) => k.path === path);
  if (!spec) return [];
  return spec.kind === 'secret' || spec.kind === 'secret-map'
    ? [spec.env, `${spec.env}_FILE`]
    : [spec.env];
}

/**
 * Whether a configuration path holds a secret: the keys whose variable accepts a
 * `_FILE` sibling, every entry of `encryption.previous_keys`, the secret fields of a
 * sign-in provider, and anything under the retired `providers.` block (never read,
 * but a `${NAME}` it references is treated as a secret's).
 */
export function isSecretKeyPath(path: string): boolean {
  const named = namedFieldOf(path);
  if (named) return named.spec?.kind === 'secret';
  if (path.startsWith(`${RETIRED_PROVIDERS_KEY}.`)) return true;
  if (path.startsWith('encryption.previous_keys.')) return true;
  const spec = KEYS.find((k) => k.path === path);
  return spec !== undefined && (spec.kind === 'secret' || spec.kind === 'secret-map');
}

/**
 * The variables of `env` that carry a secret or the path of one: the secret keys of
 * the table and their `_FILE` siblings, `VAUBAAN_SIGN_IN_<ID>_CLIENT_SECRET[_FILE]`,
 * and every retired `VAUBAAN_PROVIDER_*` variable. The variables a YAML
 * file references at a secret key are added by the loader (`FileSourceResult`).
 */
export function secretEnvVariables(env: EnvSource): string[] {
  const out = new Set<string>();
  for (const spec of KEYS) {
    if (spec.kind !== 'secret' && spec.kind !== 'secret-map') continue;
    for (const name of [spec.env, `${spec.env}_FILE`]) {
      if (env[name] !== undefined) out.add(name);
    }
  }
  for (const name of Object.keys(env)) {
    if (env[name] === undefined) continue;
    const base = name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name;
    for (const block of NAMED_BLOCKS) {
      if (parseNamedBlockEnvName(block, base)?.spec.kind === 'secret') out.add(name);
    }
    if (name.startsWith(RETIRED_PROVIDER_ENV_PREFIX)) out.add(name);
  }
  return [...out].sort();
}

/**
 * The family, the block name and the field a path of a named block names
 * (`sign_in.acme.client_id`, `oauth_brokers.main.key`); `spec` is `undefined`
 * for a field the family does not know. `null` for any other path.
 */
function namedFieldOf(
  path: string,
): { block: NamedBlock; name: string; spec: NamedBlockField | undefined } | null {
  for (const block of NAMED_BLOCKS) {
    if (!path.startsWith(`${block.top}.`)) continue;
    const rest = path.slice(block.top.length + 1);
    const dot = rest.indexOf('.');
    if (dot <= 0 || dot === rest.length - 1) return null;
    const field = rest.slice(dot + 1);
    return { block, name: rest.slice(0, dot), spec: block.fields.find((f) => f.field === field) };
  }
  return null;
}
