/**
 * The two configuration sources, both producing the same raw tree shaped
 * like `deploy/config/gateway.example.yaml`:
 *
 * - `readEnvSource()`  — `VAUBAAN_*` environment variables (with `*_FILE`
 *   siblings for secrets);
 * - `readFileSource()` — the YAML file named by `VAUBAAN_CONFIG_FILE`, with
 *   `${NAME}` / `${file:/path}` references resolved.
 *
 * `KEYS` is the single table mapping YAML paths to environment variables; the
 * handbook and the example files are derived from it, never the other way
 * round.
 */
import { parse as parseYaml } from 'yaml';

import { type IssueList } from './errors';
import {
  type EnvSource,
  type FileReader,
  defaultFileReader,
  readEnvSecret,
  resolveRefs,
} from './secret-refs';
import { PROVIDER_APP_FIELDS, type ProviderAppField } from './types';

export type RawTree = Record<string, unknown>;

export type KeyKind = 'string' | 'secret' | 'list' | 'int' | 'bool' | 'secret-map';

export interface KeySpec {
  readonly path: string;
  readonly env: string;
  readonly kind: KeyKind;
}

export const CONFIG_FILE_ENV = 'VAUBAAN_CONFIG_FILE';
export const PROVIDER_ENV_PREFIX = 'VAUBAAN_PROVIDER_';

export const KEYS: readonly KeySpec[] = [
  { path: 'public_url', env: 'VAUBAAN_PUBLIC_URL', kind: 'string' },
  { path: 'trusted_proxies', env: 'VAUBAAN_TRUSTED_PROXIES', kind: 'list' },
  { path: 'store.path', env: 'VAUBAAN_STORE_PATH', kind: 'string' },
  { path: 'encryption.master_key', env: 'VAUBAAN_MASTER_KEY', kind: 'secret' },
  { path: 'encryption.key_version', env: 'VAUBAAN_MASTER_KEY_VERSION', kind: 'int' },
  { path: 'encryption.previous_keys', env: 'VAUBAAN_MASTER_KEY_PREVIOUS', kind: 'secret-map' },
  { path: 'idp.issuer', env: 'VAUBAAN_IDP_ISSUER', kind: 'string' },
  { path: 'idp.client_id', env: 'VAUBAAN_IDP_CLIENT_ID', kind: 'string' },
  { path: 'idp.client_secret', env: 'VAUBAAN_IDP_CLIENT_SECRET', kind: 'secret' },
  { path: 'idp.claims.sub', env: 'VAUBAAN_IDP_CLAIM_SUB', kind: 'string' },
  { path: 'idp.claims.email', env: 'VAUBAAN_IDP_CLAIM_EMAIL', kind: 'string' },
  { path: 'idp.claims.groups', env: 'VAUBAAN_IDP_CLAIM_GROUPS', kind: 'string' },
  { path: 'idp.allowed_email_domains', env: 'VAUBAAN_IDP_ALLOWED_EMAIL_DOMAINS', kind: 'list' },
  { path: 'admin.group', env: 'VAUBAAN_ADMIN_GROUP', kind: 'string' },
  { path: 'admin.emails', env: 'VAUBAAN_ADMIN_EMAILS', kind: 'list' },
  { path: 'bootstrap_token', env: 'VAUBAAN_BOOTSTRAP_TOKEN', kind: 'secret' },
  { path: 'telemetry.enabled', env: 'VAUBAAN_TELEMETRY_ENABLED', kind: 'bool' },
  { path: 'telemetry.collector_url', env: 'VAUBAAN_TELEMETRY_COLLECTOR_URL', kind: 'string' },
  { path: 'retention_days', env: 'VAUBAAN_RETENTION_DAYS', kind: 'int' },
  { path: 'requests.expiry', env: 'VAUBAAN_REQUEST_EXPIRY', kind: 'string' },
  { path: 'approvals.expiry', env: 'VAUBAAN_APPROVAL_EXPIRY', kind: 'string' },
  { path: 'log.level', env: 'VAUBAAN_LOG_LEVEL', kind: 'string' },
];

const SECRET_PROVIDER_FIELDS: ReadonlySet<ProviderAppField> = new Set([
  'client_secret',
  'private_key',
]);

/** Environment variable names that set a given YAML path (for error messages). */
export function envNamesFor(path: string): string[] {
  const providerMatch = /^providers\.([^.]+)\.([^.]+)$/.exec(path);
  if (providerMatch) {
    const [, id, field] = providerMatch;
    const name = providerEnvName(id ?? '', field ?? '');
    return SECRET_PROVIDER_FIELDS.has(field as ProviderAppField) ? [name, `${name}_FILE`] : [name];
  }
  const spec = KEYS.find((k) => k.path === path);
  if (!spec) return [];
  return spec.kind === 'secret' || spec.kind === 'secret-map'
    ? [spec.env, `${spec.env}_FILE`]
    : [spec.env];
}

export function providerEnvName(providerId: string, field: string): string {
  return `${PROVIDER_ENV_PREFIX}${providerId.toUpperCase().replace(/-/g, '_')}_${field.toUpperCase()}`;
}

/* ------------------------------------------------------------------------ */
/* Environment source                                                        */
/* ------------------------------------------------------------------------ */

export function readEnvSource(
  env: EnvSource,
  issues: IssueList,
  readFile: FileReader = defaultFileReader,
): RawTree {
  const tree: RawTree = {};
  for (const spec of KEYS) {
    const value = readEnvValue(spec, env, issues, readFile);
    if (value !== undefined) setPath(tree, spec.path, value);
  }
  readProviderEnv(env, tree, issues, readFile);
  return tree;
}

function readEnvValue(
  spec: KeySpec,
  env: EnvSource,
  issues: IssueList,
  readFile: FileReader,
): unknown {
  if (spec.kind === 'secret' || spec.kind === 'secret-map') {
    const raw = readEnvSecret(spec.env, spec.path, env, readFile, issues);
    if (raw === undefined) return undefined;
    return spec.kind === 'secret' ? raw : parseSecretMap(raw, spec, issues);
  }
  const raw = env[spec.env];
  if (raw === undefined) return undefined;
  switch (spec.kind) {
    case 'string':
      return raw;
    case 'list':
      return splitList(raw);
    case 'int': {
      const n = Number(raw.trim());
      if (!Number.isInteger(n)) {
        issues.add(spec.path, `expected an integer, got "${raw}"`, [spec.env]);
        return undefined;
      }
      return n;
    }
    case 'bool': {
      const b = parseBool(raw);
      if (b === undefined)
        issues.add(spec.path, `expected true or false, got "${raw}"`, [spec.env]);
      return b;
    }
  }
}

/** `1=<base64>,2=<base64>` → `{ "1": "<base64>", "2": "<base64>" }`. */
function parseSecretMap(raw: string, spec: KeySpec, issues: IssueList): RawTree | undefined {
  const out: RawTree = {};
  for (const entry of splitList(raw)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      issues.add(spec.path, `expected "<version>=<key>" entries, got "${entry}"`, [spec.env]);
      return undefined;
    }
    out[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
  }
  return out;
}

/**
 * `VAUBAAN_PROVIDER_<ID>_<FIELD>[_FILE]` → `providers.<id>.<field>`.
 * The field is matched as a suffix against the known field names so that
 * provider ids containing `-` (`cloudflare-dns` → `CLOUDFLARE_DNS`) parse
 * unambiguously. No provider list is involved: the id is whatever remains.
 */
function readProviderEnv(
  env: EnvSource,
  tree: RawTree,
  issues: IssueList,
  readFile: FileReader,
): void {
  const fieldsLongestFirst = [...PROVIDER_APP_FIELDS].sort((a, b) => b.length - a.length);
  const seen = new Set<string>();
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(PROVIDER_ENV_PREFIX) || env[name] === undefined) continue;
    const base = name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name;
    if (seen.has(base)) continue;
    seen.add(base);
    const rest = base.slice(PROVIDER_ENV_PREFIX.length);
    const field = fieldsLongestFirst.find((f) => rest.endsWith(`_${f.toUpperCase()}`));
    const idPart = field ? rest.slice(0, -(field.length + 1)) : '';
    if (!field || idPart.length === 0) {
      issues.add(
        `providers`,
        `${name} does not end with a known provider app field (${PROVIDER_APP_FIELDS.join(', ')})`,
        [name],
      );
      continue;
    }
    const providerId = idPart.toLowerCase().replace(/_/g, '-');
    const path = `providers.${providerId}.${field}`;
    const value = SECRET_PROVIDER_FIELDS.has(field)
      ? readEnvSecret(base, path, env, readFile, issues)
      : env[base];
    if (value !== undefined) setPath(tree, path, value);
  }
}

/* ------------------------------------------------------------------------ */
/* File source                                                               */
/* ------------------------------------------------------------------------ */

export interface FileSourceResult {
  readonly tree: RawTree;
  /** Absolute or relative path that was read, for the boot log. */
  readonly path: string;
}

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
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    issues.add(CONFIG_FILE_ENV, `cannot read "${path}": ${describe(err)}`, [CONFIG_FILE_ENV]);
    return { tree: {}, path };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text) as unknown;
  } catch (err) {
    issues.add(CONFIG_FILE_ENV, `"${path}" is not valid YAML: ${describe(err)}`, [CONFIG_FILE_ENV]);
    return { tree: {}, path };
  }
  if (parsed === null || parsed === undefined) return { tree: {}, path };
  if (!isPlainObject(parsed)) {
    issues.add(CONFIG_FILE_ENV, `"${path}" must contain a YAML mapping at the top level`, [
      CONFIG_FILE_ENV,
    ]);
    return { tree: {}, path };
  }
  return { tree: resolveTree(parsed, '', env, readFile, issues), path };
}

function resolveTree(
  node: RawTree,
  prefix: string,
  env: EnvSource,
  readFile: FileReader,
  issues: IssueList,
): RawTree {
  const out: RawTree = {};
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out[key] = resolveValue(value, path, env, readFile, issues);
  }
  return out;
}

function resolveValue(
  value: unknown,
  path: string,
  env: EnvSource,
  readFile: FileReader,
  issues: IssueList,
): unknown {
  if (typeof value === 'string') return resolveRefs(value, path, env, readFile, issues);
  if (Array.isArray(value)) {
    return value.map((item, i) => resolveValue(item, `${path}[${i}]`, env, readFile, issues));
  }
  if (isPlainObject(value)) return resolveTree(value, path, env, readFile, issues);
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
