/**
 * The two configuration sources, both producing the same raw tree shaped
 * like `deploy/config/gateway.example.yaml`:
 *
 * - `readEnvSource()`  — `VAUBAAN_*` environment variables (with `*_FILE`
 *   siblings for secrets);
 * - `readFileSource()` — the YAML file named by `VAUBAAN_CONFIG_FILE`, with
 *   `${NAME}` / `${file:/path}` references resolved.
 *
 * `KEYS` is the single table of configuration keys: YAML path, environment
 * variable, how the variable is parsed, and the defaults and bounds the loader
 * applies (`load.ts` reads them from here, it holds no second copy). The
 * handbook table and the example files are derived from it, never the other
 * way round; `keys-doc.test.ts` holds the handbook to it.
 */
import { TELEMETRY_LEVELS } from '@vaubaan/telemetry';
import { parse as parseYaml } from 'yaml';
import { CLIENT_IP_HEADERS } from '../http/client-ip';

import { errorMessage, type IssueList } from './errors';
import {
  type EnvSource,
  type FileReader,
  type SourceContext,
  type SourceTrace,
  defaultFileReader,
  readEnvSecret,
  resolveRefs,
} from './secret-refs';
import { INSTANCE_NAME_MAX_LENGTH } from './instance-name';
import { DEFAULT_TELEMETRY_COLLECTOR_URL } from './telemetry-default';
import { DEFAULT_UPDATES_FEED_URL } from './updates-default';
import { CLIENT_REGISTRATION_POLICIES, LOG_LEVELS, MAIL_TLS_MODES } from './types';

export type RawTree = Record<string, unknown>;

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
/**
 * The prefix of the variables that declared an OAuth client per provider in
 * earlier versions (`VAUBAAN_PROVIDER_<ID>_<FIELD>[_FILE]`). They are no longer
 * read: the loader lists them as retired, and they are taken out of the process
 * environment with the secrets, since one of them held a client secret.
 */
export const RETIRED_PROVIDER_ENV_PREFIX = 'VAUBAAN_PROVIDER_';
export const SIGN_IN_ENV_PREFIX = 'VAUBAAN_SIGN_IN_';

/**
 * The fields of one sign-in provider (`sign_in.<id>.<field>`), with the suffix of
 * its environment variable (`VAUBAAN_SIGN_IN_<ID>_<SUFFIX>`) and how that variable
 * is read. One table: the loader, the env reader and the handbook's row derive from it.
 */
export const SIGN_IN_FIELDS = [
  { field: 'kind', env: 'KIND', kind: 'string' },
  { field: 'name', env: 'NAME', kind: 'string' },
  { field: 'issuer', env: 'ISSUER', kind: 'string' },
  { field: 'client_id', env: 'CLIENT_ID', kind: 'string' },
  { field: 'client_secret', env: 'CLIENT_SECRET', kind: 'secret' },
  { field: 'claims.sub', env: 'CLAIM_SUB', kind: 'string' },
  { field: 'claims.email', env: 'CLAIM_EMAIL', kind: 'string' },
  { field: 'claims.groups', env: 'CLAIM_GROUPS', kind: 'string' },
  { field: 'claims.email_verified', env: 'CLAIM_EMAIL_VERIFIED', kind: 'string' },
  { field: 'allowed_email_domains', env: 'ALLOWED_EMAIL_DOMAINS', kind: 'list' },
  { field: 'invitation_only', env: 'INVITATION_ONLY', kind: 'bool' },
  { field: 'require_verified_email', env: 'REQUIRE_VERIFIED_EMAIL', kind: 'bool' },
] as const satisfies readonly NamedBlockField[];
export type SignInField = (typeof SIGN_IN_FIELDS)[number]['field'];

export const OAUTH_BROKER_ENV_PREFIX = 'VAUBAAN_OAUTH_BROKER_';

/**
 * The fields of one OAuth broker the instance is enrolled with
 * (`oauth_brokers.<name>.<field>`, ADR google-calendar-through-an-oauth-broker
 * D1), with the suffix of its variable (`VAUBAAN_OAUTH_BROKER_<NAME>_<SUFFIX>`).
 * `key` is a secret like every other: a `_FILE` sibling or `${file:…}`.
 * `attestation` is `required` (the default) or `none` (ADR
 * oauth-broker-stateless-in-an-attested-enclave D4).
 */
export const OAUTH_BROKER_FIELDS = [
  { field: 'url', env: 'URL', kind: 'string' },
  { field: 'key', env: 'KEY', kind: 'secret' },
  { field: 'providers', env: 'PROVIDERS', kind: 'list' },
  { field: 'attestation', env: 'ATTESTATION', kind: 'string' },
] as const satisfies readonly NamedBlockField[];

/** One field of a family of named blocks (`sign_in.<id>.*`, `oauth_brokers.<name>.*`). */
export interface NamedBlockField {
  readonly field: string;
  readonly env: string;
  readonly kind: 'string' | 'secret' | 'list' | 'bool';
}

/**
 * A family of named blocks: the top-level key, the prefix of its variables
 * (`<prefix><NAME>_<SUFFIX>`, a hyphen of the name ↔ an underscore) and its
 * fields. The env reader, `envNamesFor`, `isSecretKeyPath` and
 * `secretEnvVariables` read every family from `NAMED_BLOCKS`.
 */
export interface NamedBlock {
  readonly top: string;
  /** What one block is, in an error message ("sign-in provider"). */
  readonly noun: string;
  readonly prefix: string;
  readonly fields: readonly NamedBlockField[];
}

export const SIGN_IN_BLOCK: NamedBlock = {
  top: 'sign_in',
  noun: 'sign-in provider',
  prefix: SIGN_IN_ENV_PREFIX,
  fields: SIGN_IN_FIELDS,
};
export const OAUTH_BROKER_BLOCK: NamedBlock = {
  top: 'oauth_brokers',
  noun: 'OAuth broker',
  prefix: OAUTH_BROKER_ENV_PREFIX,
  fields: OAUTH_BROKER_FIELDS,
};
export const NAMED_BLOCKS: readonly NamedBlock[] = [SIGN_IN_BLOCK, OAUTH_BROKER_BLOCK];

const KEY_TABLE = [
  {
    path: 'public_url',
    env: 'VAUBAAN_PUBLIC_URL',
    kind: 'string',
    format: 'url',
    required: 'always',
    https: true,
  },
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
  // instance sends its own mail — the links of the local accounts. Optional as a block:
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
  // a provider that never answers releases the request, the credential and the slot.
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
  // Ceilings (spec §4.3 bis): absent is unlimited, the default. Enforced where an
  // item would be added, never by cutting (`server/limits`).
  { path: 'limits.users', env: 'VAUBAAN_LIMITS_USERS', kind: 'int', min: 1 },
  { path: 'limits.connections', env: 'VAUBAAN_LIMITS_CONNECTIONS', kind: 'int', min: 1 },
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
  // The bearer of `GET /ops/stats` (spec §4.3 bis): absent, the endpoint does not exist.
  { path: 'ops.token', env: 'VAUBAAN_OPS_TOKEN', kind: 'secret', minLength: 32 },
  {
    path: 'oauth.access_token_ttl',
    env: 'VAUBAAN_OAUTH_ACCESS_TOKEN_TTL',
    kind: 'string',
    format: 'duration',
    default: '15m',
    maxSeconds: 3_600,
  },
  {
    path: 'oauth.refresh_token_ttl',
    env: 'VAUBAAN_OAUTH_REFRESH_TOKEN_TTL',
    kind: 'string',
    format: 'duration',
    default: '30d',
  },
  {
    path: 'oauth.delegation_max_lifetime',
    env: 'VAUBAAN_OAUTH_DELEGATION_MAX_LIFETIME',
    kind: 'string',
    format: 'duration',
    default: '90d',
  },
  {
    path: 'oauth.refresh_reuse_window_seconds',
    env: 'VAUBAAN_OAUTH_REFRESH_REUSE_WINDOW_SECONDS',
    kind: 'int',
    default: 30,
    min: 0,
    max: 60,
  },
  {
    path: 'oauth.client_registration.policy',
    env: 'VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY',
    kind: 'string',
    format: 'enum',
    default: 'operator-approved',
    oneOf: CLIENT_REGISTRATION_POLICIES,
  },
  {
    path: 'oauth.client_registration.auto_approve_loopback',
    env: 'VAUBAAN_OAUTH_CLIENT_REGISTRATION_AUTO_APPROVE_LOOPBACK',
    kind: 'bool',
    default: true,
  },
  {
    path: 'oauth.client_registration.metadata_documents',
    env: 'VAUBAAN_OAUTH_CLIENT_REGISTRATION_METADATA_DOCUMENTS',
    kind: 'bool',
    default: false,
  },
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

/** `<prefix><NAME>_<SUFFIX>`: a hyphen of the name becomes an underscore. */
export function namedBlockEnvName(block: NamedBlock, name: string, suffix: string): string {
  return `${block.prefix}${name.toUpperCase().replace(/-/g, '_')}_${suffix}`;
}

/**
 * The single-provider keys of earlier builds (`idp.*`, `VAUBAAN_IDP_*`): retired, and
 * refused rather than ignored — ignoring them would leave the instance without the
 * provider people sign in with. They are written as `sign_in.idp.*` now.
 */
export const RETIRED_IDP_KEY = 'idp';
export const RETIRED_IDP_ENV_PREFIX = 'VAUBAAN_IDP_';

/** The top-level key of the retired per-provider OAuth clients (`providers.<id>.<field>`). */
export const RETIRED_PROVIDERS_KEY = 'providers';

/**
 * The retired keys and variables a configuration still sets, sorted: every leaf
 * under the file's `providers` block, and every `VAUBAAN_PROVIDER_*` variable.
 * Never read; listed so the root can say they are ignored.
 */
export function retiredConfigKeys(tree: RawTree, env: EnvSource): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (isPlainObject(node) && Object.keys(node).length > 0) {
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
      return;
    }
    out.push(path);
  };
  if (tree[RETIRED_PROVIDERS_KEY] !== undefined) {
    walk(tree[RETIRED_PROVIDERS_KEY], RETIRED_PROVIDERS_KEY);
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith(RETIRED_PROVIDER_ENV_PREFIX) && env[name] !== undefined) out.push(name);
  }
  return out.sort();
}

/** `VAUBAAN_SIGN_IN_<ID>_<SUFFIX>`: a hyphen of the provider id becomes an underscore. */
export function signInEnvName(providerId: string, suffix: string): string {
  return namedBlockEnvName(SIGN_IN_BLOCK, providerId, suffix);
}

/* ------------------------------------------------------------------------ */
/* Environment source                                                        */
/* ------------------------------------------------------------------------ */

export function readEnvSource(
  env: EnvSource,
  issues: IssueList,
  readFile: FileReader = defaultFileReader,
  trace?: SourceTrace,
): RawTree {
  const ctx: SourceContext = { env, readFile, issues, trace };
  const tree: RawTree = {};
  for (const spec of KEYS) {
    const value = readEnvValue(ctx, spec);
    if (value !== undefined) setPath(tree, spec.path, value);
  }
  readNamedBlocksEnv(ctx, tree);
  return tree;
}

function readEnvValue(ctx: SourceContext, spec: KeySpec): unknown {
  if (spec.kind === 'secret' || spec.kind === 'secret-map') {
    const raw = readEnvSecret(ctx, spec.env, spec.path);
    if (raw === undefined) return undefined;
    return spec.kind === 'secret' ? raw : parseSecretMap(ctx, raw, spec);
  }
  const raw = ctx.env[spec.env];
  if (raw === undefined) return undefined;
  switch (spec.kind) {
    case 'string':
      return raw;
    case 'list':
      return splitList(raw);
    case 'int': {
      const n = raw.trim() === '' ? Number.NaN : Number(raw.trim());
      if (!Number.isInteger(n)) {
        ctx.issues.add(spec.path, `expected an integer, got "${raw}"`, [spec.env]);
        return undefined;
      }
      return n;
    }
    case 'bool': {
      const b = parseBool(raw);
      if (b === undefined)
        ctx.issues.add(spec.path, `expected true or false, got "${raw}"`, [spec.env]);
      return b;
    }
  }
}

/** `1=<base64>,2=<base64>` → `{ "1": "<base64>", "2": "<base64>" }`. The entries
 *  are secrets: a malformed one is reported by position, never echoed. */
function parseSecretMap(ctx: SourceContext, raw: string, spec: KeySpec): RawTree | undefined {
  const out: RawTree = {};
  const entries = splitList(raw);
  for (const [i, entry] of entries.entries()) {
    const eq = entry.indexOf('=');
    const version = eq > 0 ? entry.slice(0, eq).trim() : '';
    // The version must be a bare integer: a base64 key pasted without `<version>=`
    // carries `=` padding and must not be split (and echoed) as if it were one.
    if (!/^\d+$/.test(version)) {
      ctx.issues.add(spec.path, `entry #${i + 1} is not of the form "<version>=<key>"`, [spec.env]);
      return undefined;
    }
    out[version] = entry.slice(eq + 1).trim();
  }
  return out;
}

/**
 * `<prefix><NAME>_<FIELD>[_FILE]` → `<top>.<name>.<field>`, for every family of
 * `NAMED_BLOCKS`. The field is matched as a suffix so that a name with a hyphen
 * (`acme-entra` → `ACME_ENTRA`) parses unambiguously.
 */
function readNamedBlocksEnv(ctx: SourceContext, tree: RawTree): void {
  for (const block of NAMED_BLOCKS) readNamedBlockEnv(ctx, tree, block);
}

function readNamedBlockEnv(ctx: SourceContext, tree: RawTree, block: NamedBlock): void {
  const seen = new Set<string>();
  for (const name of Object.keys(ctx.env).sort()) {
    if (!name.startsWith(block.prefix) || ctx.env[name] === undefined) continue;
    const base = name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name;
    if (seen.has(base)) continue;
    seen.add(base);
    const parsed = parseNamedBlockEnvName(block, base);
    if (!parsed) {
      ctx.issues.add(
        block.top,
        `${name} does not end with a known ${block.noun} field (${block.fields.map((f) => f.env).join(', ')})`,
        [name],
      );
      continue;
    }
    const path = `${block.top}.${parsed.name}.${parsed.spec.field}`;
    let value: unknown;
    switch (parsed.spec.kind) {
      case 'secret':
        value = readEnvSecret(ctx, base, path);
        break;
      case 'list':
        value = ctx.env[base] === undefined ? undefined : splitList(ctx.env[base] ?? '');
        break;
      case 'bool': {
        const raw = ctx.env[base] ?? '';
        value = parseBool(raw);
        if (value === undefined)
          ctx.issues.add(path, `expected true or false, got "${raw}"`, [base]);
        break;
      }
      case 'string':
        value = ctx.env[base];
        break;
    }
    if (value !== undefined) setPath(tree, path, value);
  }
}

/**
 * `VAUBAAN_SIGN_IN_ACME_ENTRA_CLIENT_ID` → `{ name: 'acme-entra', spec: client_id }`;
 * `null` when the variable is not of the family, does not end with a known
 * field or has no name part.
 */
export function parseNamedBlockEnvName(
  block: NamedBlock,
  variable: string,
): { name: string; spec: NamedBlockField } | null {
  if (!variable.startsWith(block.prefix)) return null;
  const rest = variable.slice(block.prefix.length);
  const spec = [...block.fields]
    .sort((a, b) => b.env.length - a.env.length)
    .find((f) => rest.endsWith(`_${f.env}`));
  if (!spec) return null;
  const namePart = rest.slice(0, -(spec.env.length + 1));
  if (namePart.length === 0) return null;
  return { name: namePart.toLowerCase().replace(/_/g, '-'), spec };
}

/** `VAUBAAN_SIGN_IN_ACME_ENTRA_CLIENT_ID` → `{ providerId: 'acme-entra', spec: client_id }`. */
export function parseSignInEnvName(
  name: string,
): { providerId: string; spec: (typeof SIGN_IN_FIELDS)[number] } | null {
  const parsed = parseNamedBlockEnvName(SIGN_IN_BLOCK, name);
  if (!parsed) return null;
  const spec = SIGN_IN_FIELDS.find((f) => f.field === parsed.spec.field);
  return spec ? { providerId: parsed.name, spec } : null;
}

/* ------------------------------------------------------------------------ */
/* File source                                                               */
/* ------------------------------------------------------------------------ */

export interface FileSourceResult {
  readonly tree: RawTree;
  /** Absolute or relative path that was read, for the boot log. */
  readonly path: string;
  /** Environment variables the file references (`${NAME}`) at a secret key. */
  readonly secretVariables: readonly string[];
}

/** What resolving the file needs beyond the source context: where secret references go. */
interface FileContext extends SourceContext {
  readonly secretVariables: Set<string>;
}

const VARIABLE_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Reads the YAML file named by `VAUBAAN_CONFIG_FILE`. Returns `null` when the
 * variable is unset (environment-only configuration). A set variable that
 * points to an unreadable or invalid file is an error.
 */
export function readFileSource(
  env: EnvSource,
  issues: IssueList,
  readFile: FileReader = defaultFileReader,
  trace?: SourceTrace,
): FileSourceResult | null {
  const path = env[CONFIG_FILE_ENV];
  if (path === undefined || path.trim() === '') return null;
  const ctx: FileContext = { env, readFile, issues, trace, secretVariables: new Set() };
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    issues.add(CONFIG_FILE_ENV, `cannot read "${path}": ${errorMessage(err)}`, [CONFIG_FILE_ENV]);
    return { tree: {}, path, secretVariables: [] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text) as unknown;
  } catch (err) {
    issues.add(CONFIG_FILE_ENV, `"${path}" is not valid YAML: ${errorMessage(err)}`, [
      CONFIG_FILE_ENV,
    ]);
    return { tree: {}, path, secretVariables: [] };
  }
  if (parsed === null || parsed === undefined) return { tree: {}, path, secretVariables: [] };
  if (!isPlainObject(parsed)) {
    issues.add(CONFIG_FILE_ENV, `"${path}" must contain a YAML mapping at the top level`, [
      CONFIG_FILE_ENV,
    ]);
    return { tree: {}, path, secretVariables: [] };
  }
  const tree = resolveTree(ctx, parsed, '', new Set([parsed]));
  return { tree, path, secretVariables: [...ctx.secretVariables] };
}

/**
 * The nodes being resolved, from the root down: a YAML alias used inside its
 * own anchor (`a: &x [*x]`) parses to a value that contains itself, which
 * would recurse until the stack overflows. It is reported as an issue of its
 * key instead (found by the property tests of the loader).
 */
type Ancestors = ReadonlySet<object>;

function resolveTree(
  ctx: FileContext,
  node: RawTree,
  prefix: string,
  ancestors: Ancestors,
): RawTree {
  const out: RawTree = {};
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // Assigned, `__proto__` would replace the prototype of `out` instead of
    // adding a key (a value with no prototype then breaks every message that
    // quotes it). No configuration key has that name.
    if (key === '__proto__') {
      ctx.issues.add(path, 'is not a configuration key', [CONFIG_FILE_ENV]);
      continue;
    }
    out[key] = resolveValue(ctx, value, path, ancestors);
  }
  return out;
}

function resolveValue(
  ctx: FileContext,
  value: unknown,
  path: string,
  ancestors: Ancestors,
): unknown {
  if (typeof value === 'string') {
    if (isSecretKeyPath(path)) {
      for (const match of value.matchAll(VARIABLE_REF)) {
        if (match[1] !== undefined) ctx.secretVariables.add(match[1]);
      }
    }
    return resolveRefs(ctx, value, path);
  }
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) {
    ctx.issues.add(path, 'refers to itself (a YAML alias inside its own anchor)', [
      CONFIG_FILE_ENV,
    ]);
    return undefined;
  }
  const inside = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.map((item, i) => resolveValue(ctx, item, `${path}[${i}]`, inside));
  }
  if (isPlainObject(value)) return resolveTree(ctx, value, path, inside);
  return value;
}

/* ------------------------------------------------------------------------ */
/* Tree helpers                                                              */
/* ------------------------------------------------------------------------ */

export function isPlainObject(value: unknown): value is RawTree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function setPath(tree: RawTree, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = tree;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (isPlainObject(next)) {
      node = next;
    } else {
      const created: RawTree = {};
      node[part] = created;
      node = created;
    }
  }
  node[parts[parts.length - 1] ?? ''] = value;
}

export function getPath(tree: RawTree, path: string): unknown {
  let node: unknown = tree;
  for (const part of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    // nosemgrep: prototype-pollution-loop -- read-only walk of the operator's configuration tree; nothing is assigned
    node = node[part];
  }
  return node;
}

/** Deep merge where `over` wins on every leaf; objects merge key by key. */
export function mergeTrees(base: RawTree, over: RawTree): RawTree {
  const out: RawTree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergeTrees(existing, value) : value;
  }
  return out;
}

export function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return undefined;
}
