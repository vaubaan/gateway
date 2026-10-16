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
  defaultFileReader,
  readEnvSecret,
  resolveRefs,
} from './secret-refs';
import { INSTANCE_NAME_MAX_LENGTH } from './instance-name';
import { DEFAULT_TELEMETRY_COLLECTOR_URL } from './telemetry-default';
import {
  CLIENT_REGISTRATION_POLICIES,
  LOG_LEVELS,
  PROVIDER_APP_FIELDS,
  isProviderAppField,
  type ProviderAppField,
} from './types';

export type RawTree = Record<string, unknown>;

export type KeyKind = 'string' | 'secret' | 'list' | 'int' | 'bool' | 'secret-map';

/** What a `string` key holds when it is more than free text. */
export type KeyFormat = 'url' | 'duration' | 'enum';

/**
 * When a key must be set: always, once the `idp` block exists (`with-idp`), or as
 * long as the configuration sets no sign-in provider at all — neither `idp.*` nor
 * any `sign_in.<id>.*` (`without-idp`).
 */
export type KeyRequirement = 'always' | 'with-idp' | 'without-idp';

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
export const PROVIDER_ENV_PREFIX = 'VAUBAAN_PROVIDER_';
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
] as const satisfies readonly {
  readonly field: string;
  readonly env: string;
  readonly kind: 'string' | 'secret' | 'list' | 'bool';
}[];
export type SignInField = (typeof SIGN_IN_FIELDS)[number]['field'];

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
  { path: 'store.path', env: 'VAUBAAN_STORE_PATH', kind: 'string', required: 'always' },
  // A presigned URL is a credential: `restore.from` is a secret (ADR
  // restore-verifies-before-it-replaces-and-runs-at-first-boot).
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
  {
    path: 'idp.issuer',
    env: 'VAUBAAN_IDP_ISSUER',
    kind: 'string',
    format: 'url',
    required: 'with-idp',
    https: true,
  },
  { path: 'idp.client_id', env: 'VAUBAAN_IDP_CLIENT_ID', kind: 'string', required: 'with-idp' },
  {
    path: 'idp.client_secret',
    env: 'VAUBAAN_IDP_CLIENT_SECRET',
    kind: 'secret',
    required: 'with-idp',
  },
  { path: 'idp.claims.sub', env: 'VAUBAAN_IDP_CLAIM_SUB', kind: 'string', default: 'sub' },
  { path: 'idp.claims.email', env: 'VAUBAAN_IDP_CLAIM_EMAIL', kind: 'string', default: 'email' },
  { path: 'idp.claims.groups', env: 'VAUBAAN_IDP_CLAIM_GROUPS', kind: 'string', default: 'groups' },
  { path: 'idp.allowed_email_domains', env: 'VAUBAAN_IDP_ALLOWED_EMAIL_DOMAINS', kind: 'list' },
  {
    path: 'idp.invitation_only',
    env: 'VAUBAAN_IDP_INVITATION_ONLY',
    kind: 'bool',
    default: false,
  },
  { path: 'admin.group', env: 'VAUBAAN_ADMIN_GROUP', kind: 'string' },
  { path: 'admin.emails', env: 'VAUBAAN_ADMIN_EMAILS', kind: 'list' },
  {
    path: 'bootstrap_token',
    env: 'VAUBAAN_BOOTSTRAP_TOKEN',
    kind: 'secret',
    required: 'without-idp',
    minLength: 32,
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
 * Whether a key must be set. `idpConfigured` says whether the `idp` block
 * exists; it only matters to the keys whose requirement depends on it.
 */
export function isKeyRequired(spec: KeySpec, idpConfigured?: boolean): boolean {
  switch (spec.required) {
    case 'always':
      return true;
    case 'with-idp':
      return idpConfigured === true;
    case 'without-idp':
      return idpConfigured === false;
    case undefined:
      return false;
  }
}

const SECRET_PROVIDER_FIELDS: ReadonlySet<ProviderAppField> = new Set([
  'client_secret',
  'private_key',
]);

/** Environment variable names that set a given YAML path (for error messages). */
export function envNamesFor(path: string): string[] {
  const signInMatch = /^sign_in\.([^.]+)\.(.+)$/.exec(path);
  if (signInMatch) {
    const [, id = '', field = ''] = signInMatch;
    const spec = SIGN_IN_FIELDS.find((f) => f.field === field);
    if (!spec) return [];
    const name = signInEnvName(id, spec.env);
    return spec.kind === 'secret' ? [name, `${name}_FILE`] : [name];
  }
  const providerMatch = /^providers\.([^.]+)\.([^.]+)$/.exec(path);
  if (providerMatch) {
    const [, id, field] = providerMatch;
    const fieldName = field ?? '';
    const name = providerEnvName(id ?? '', fieldName);
    return isProviderAppField(fieldName) && SECRET_PROVIDER_FIELDS.has(fieldName)
      ? [name, `${name}_FILE`]
      : [name];
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
 * sign-in provider and of a provider app.
 */
export function isSecretKeyPath(path: string): boolean {
  const signInMatch = /^sign_in\.([^.]+)\.(.+)$/.exec(path);
  if (signInMatch) {
    return SIGN_IN_FIELDS.some((f) => f.field === signInMatch[2] && f.kind === 'secret');
  }
  const providerMatch = /^providers\.([^.]+)\.([^.]+)$/.exec(path);
  if (providerMatch) {
    const field = providerMatch[2] ?? '';
    return isProviderAppField(field) && SECRET_PROVIDER_FIELDS.has(field);
  }
  if (path.startsWith('encryption.previous_keys.')) return true;
  const spec = KEYS.find((k) => k.path === path);
  return spec !== undefined && (spec.kind === 'secret' || spec.kind === 'secret-map');
}

/**
 * The variables of `env` that carry a secret or the path of one: the secret keys of
 * the table and their `_FILE` siblings, `VAUBAAN_SIGN_IN_<ID>_CLIENT_SECRET[_FILE]`,
 * `VAUBAAN_PROVIDER_<ID>_{CLIENT_SECRET,PRIVATE_KEY}[_FILE]`. The variables a YAML
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
    if (parseSignInEnvName(base)?.spec.kind === 'secret') out.add(name);
    const provider = parseProviderEnvName(base);
    if (provider && SECRET_PROVIDER_FIELDS.has(provider.field)) out.add(name);
  }
  return [...out].sort();
}

export function providerEnvName(providerId: string, field: string): string {
  return `${PROVIDER_ENV_PREFIX}${providerId.toUpperCase().replace(/-/g, '_')}_${field.toUpperCase()}`;
}

/** `VAUBAAN_SIGN_IN_<ID>_<SUFFIX>`: a hyphen of the provider id becomes an underscore. */
export function signInEnvName(providerId: string, suffix: string): string {
  return `${SIGN_IN_ENV_PREFIX}${providerId.toUpperCase().replace(/-/g, '_')}_${suffix}`;
}

/* ------------------------------------------------------------------------ */
/* Environment source                                                        */
/* ------------------------------------------------------------------------ */

export function readEnvSource(
  env: EnvSource,
  issues: IssueList,
  readFile: FileReader = defaultFileReader,
): RawTree {
  const ctx: SourceContext = { env, readFile, issues };
  const tree: RawTree = {};
  for (const spec of KEYS) {
    const value = readEnvValue(ctx, spec);
    if (value !== undefined) setPath(tree, spec.path, value);
  }
  readProviderEnv(ctx, tree);
  readSignInEnv(ctx, tree);
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
 * `VAUBAAN_PROVIDER_<ID>_<FIELD>[_FILE]` → `providers.<id>.<field>`.
 * The field is matched as a suffix against the known field names so that
 * provider ids containing `-` (`cloudflare-dns` → `CLOUDFLARE_DNS`) parse
 * unambiguously. No provider list is involved: the id is whatever remains.
 */
function readProviderEnv(ctx: SourceContext, tree: RawTree): void {
  const seen = new Set<string>();
  for (const name of Object.keys(ctx.env).sort()) {
    if (!name.startsWith(PROVIDER_ENV_PREFIX) || ctx.env[name] === undefined) continue;
    const base = name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name;
    if (seen.has(base)) continue;
    seen.add(base);
    const parsed = parseProviderEnvName(base);
    if (!parsed) {
      ctx.issues.add(
        `providers`,
        `${name} does not end with a known provider app field (${PROVIDER_APP_FIELDS.join(', ')})`,
        [name],
      );
      continue;
    }
    const path = `providers.${parsed.providerId}.${parsed.field}`;
    const value = SECRET_PROVIDER_FIELDS.has(parsed.field)
      ? readEnvSecret(ctx, base, path)
      : ctx.env[base];
    if (value !== undefined) setPath(tree, path, value);
  }
}

const FIELDS_LONGEST_FIRST = [...PROVIDER_APP_FIELDS].sort((a, b) => b.length - a.length);

/**
 * `VAUBAAN_SIGN_IN_<ID>_<FIELD>[_FILE]` → `sign_in.<id>.<field>`. As for provider
 * apps, the field is matched as a suffix so that an id with a hyphen
 * (`acme-entra` → `ACME_ENTRA`) parses unambiguously.
 */
function readSignInEnv(ctx: SourceContext, tree: RawTree): void {
  const seen = new Set<string>();
  for (const name of Object.keys(ctx.env).sort()) {
    if (!name.startsWith(SIGN_IN_ENV_PREFIX) || ctx.env[name] === undefined) continue;
    const base = name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name;
    if (seen.has(base)) continue;
    seen.add(base);
    const parsed = parseSignInEnvName(base);
    if (!parsed) {
      ctx.issues.add(
        'sign_in',
        `${name} does not end with a known sign-in provider field (${SIGN_IN_FIELDS.map((f) => f.env).join(', ')})`,
        [name],
      );
      continue;
    }
    const path = `sign_in.${parsed.providerId}.${parsed.spec.field}`;
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

const SIGN_IN_FIELDS_LONGEST_FIRST = [...SIGN_IN_FIELDS].sort(
  (a, b) => b.env.length - a.env.length,
);

/**
 * `VAUBAAN_SIGN_IN_ACME_ENTRA_CLIENT_ID` → `{ providerId: 'acme-entra', spec: client_id }`;
 * `null` when the name does not end with a known field or has no id part.
 */
export function parseSignInEnvName(
  name: string,
): { providerId: string; spec: (typeof SIGN_IN_FIELDS)[number] } | null {
  if (!name.startsWith(SIGN_IN_ENV_PREFIX)) return null;
  const rest = name.slice(SIGN_IN_ENV_PREFIX.length);
  const spec = SIGN_IN_FIELDS_LONGEST_FIRST.find((f) => rest.endsWith(`_${f.env}`));
  if (!spec) return null;
  const idPart = rest.slice(0, -(spec.env.length + 1));
  if (idPart.length === 0) return null;
  return { providerId: idPart.toLowerCase().replace(/_/g, '-'), spec };
}

/**
 * `VAUBAAN_PROVIDER_CLOUDFLARE_DNS_CLIENT_SECRET` → `{ providerId: 'cloudflare-dns',
 * field: 'client_secret' }`; `null` when the name (without `_FILE`) does not end
 * with a known field or has no id part. Pure, so the hyphen and suffix rules can
 * be tested on their own.
 */
export function parseProviderEnvName(
  name: string,
): { providerId: string; field: ProviderAppField } | null {
  if (!name.startsWith(PROVIDER_ENV_PREFIX)) return null;
  const rest = name.slice(PROVIDER_ENV_PREFIX.length);
  const field = FIELDS_LONGEST_FIRST.find((f) => rest.endsWith(`_${f.toUpperCase()}`));
  if (!field) return null;
  const idPart = rest.slice(0, -(field.length + 1));
  if (idPart.length === 0) return null;
  return { providerId: idPart.toLowerCase().replace(/_/g, '-'), field };
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
): FileSourceResult | null {
  const path = env[CONFIG_FILE_ENV];
  if (path === undefined || path.trim() === '') return null;
  const ctx: FileContext = { env, readFile, issues, secretVariables: new Set() };
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
