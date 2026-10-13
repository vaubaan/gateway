/**
 * `loadInstanceConfig()` — the only way an `InstanceConfig` comes to exist.
 *
 * Precedence (ADR docker-image-and-config-format): the mounted YAML file wins
 * over environment variables, key by key. Validation collects every problem
 * and throws one `ConfigError` naming each YAML path and its variable(s).
 */
import { KEY_BYTES } from '../crypto/aead';
import { isTrustedProxyEntry } from '../http/client-ip';
import { parseDuration } from './duration';
import { ConfigError, IssueList } from './errors';
import { type EnvSource, type FileReader, defaultFileReader } from './secret-refs';
import {
  type RawTree,
  envNamesFor,
  getPath,
  isPlainObject,
  mergeTrees,
  readEnvSource,
  readFileSource,
} from './sources';
import { DEFAULT_TELEMETRY_COLLECTOR_URL } from './telemetry-default';
import {
  type AdminRule,
  CLIENT_REGISTRATION_POLICIES,
  type ClientRegistrationPolicy,
  type EncryptionConfig,
  type IdpConfig,
  type InstanceConfig,
  LOG_LEVELS,
  type LogLevel,
  type OAuthConfig,
  PROVIDER_APP_FIELD_PROPERTY,
  PROVIDER_APP_FIELDS,
  type ProviderAppConfig,
  isClientRegistrationPolicy,
  isLogLevel,
  isProviderAppField,
} from './types';

/** The master key is the AEAD key: one size, defined by the crypto module. */
export const MASTER_KEY_BYTES = KEY_BYTES;
const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULTS = {
  keyVersion: 1,
  claimSub: 'sub',
  claimEmail: 'email',
  claimGroups: 'groups',
  retentionDays: 90,
  requestExpiry: '24h',
  approvalExpiry: '10m',
  mcpRateLimitPerMinute: 600,
  oauthAccessTokenTtl: '15m',
  oauthRefreshTokenTtl: '30d',
  oauthRefreshReuseWindowSeconds: 30,
  oauthClientRegistrationPolicy: 'operator-approved',
  oauthAutoApproveLoopback: true,
  oauthMetadataDocuments: false,
} as const;

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
}

export function loadInstanceConfig(options: LoadOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? defaultFileReader;
  const issues = new IssueList();

  const fromEnv = readEnvSource(env, issues, readFile);
  const fromFile = readFileSource(env, issues, readFile);
  const raw = fromFile ? mergeTrees(fromEnv, fromFile.tree) : fromEnv;
  const config = validate(raw, issues);
  issues.throwIfAny();
  if (!config) throw new ConfigError(issues.items); // unreachable: validate() reports every failure
  return { config, configFile: fromFile?.path ?? null };
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

  int(path: string, fallback: number, min = 1): number {
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      this.issues.add(path, `expected an integer >= ${min}, got ${show(value)}`, envNamesFor(path));
      return fallback;
    }
    return value;
  }

  bool(path: string, fallback: boolean): boolean {
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

  duration(path: string, fallback: string): number {
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

function validate(raw: RawTree, issues: IssueList): InstanceConfig | null {
  const r = new Reader(raw, issues);
  const before = issues.items.length;

  const publicUrl = readPublicUrl(r);
  const trustedProxies = readTrustedProxies(r);
  const storePath = r.string('store.path', { required: true });
  const encryption = readEncryption(r);
  const idp = readIdp(r);
  const admin = readAdmin(r);
  const providers = readProviders(r);
  const bootstrapToken = readBootstrapToken(r, idp);

  const telemetryEnabled = r.bool('telemetry.enabled', false);
  // A null or mistyped value is not a decision: only a boolean pins the toggle.
  const telemetrySetByConfig = typeof getPath(raw, 'telemetry.enabled') === 'boolean';
  const collectorUrl = r.url('telemetry.collector_url', {
    fallback: DEFAULT_TELEMETRY_COLLECTOR_URL,
    https: true,
  });

  const retentionDays = r.int('retention_days', DEFAULTS.retentionDays);
  const requestExpiry = r.duration('requests.expiry', DEFAULTS.requestExpiry);
  const approvalExpiry = r.duration('approvals.expiry', DEFAULTS.approvalExpiry);
  const mcpRateLimit = r.int('mcp.rate_limit_per_minute', DEFAULTS.mcpRateLimitPerMinute);
  const oauth = readOAuth(r);
  const level = readLogLevel(r);

  if (issues.items.length > before) return null;
  if (!publicUrl || !storePath || !encryption || !admin || !collectorUrl) return null;

  return {
    publicUrl,
    trustedProxies,
    store: { path: storePath },
    encryption,
    idp,
    admin,
    providers,
    bootstrapToken,
    telemetry: {
      enabled: telemetryEnabled,
      enabledSetByConfig: telemetrySetByConfig,
      collectorUrl,
    },
    retentionDays,
    requests: { expirySeconds: requestExpiry },
    approvals: { expirySeconds: approvalExpiry },
    mcp: { rateLimitPerMinute: mcpRateLimit },
    oauth,
    log: { level },
  };
}

/** https, no query or fragment, trailing slash stripped (a sub-path is kept). */
function readPublicUrl(r: Reader): URL | undefined {
  const publicUrl = r.url('public_url', { required: true, https: true });
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

/** Required while no IdP is configured; long enough to resist guessing. */
function readBootstrapToken(r: Reader, idp: IdpConfig | null): string | null {
  const bootstrapToken = r.string('bootstrap_token', { required: idp === null }) ?? null;
  if (bootstrapToken !== null && bootstrapToken.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
    r.issues.add(
      'bootstrap_token',
      `must be at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters long`,
      envNamesFor('bootstrap_token'),
    );
  }
  return bootstrapToken;
}

/** A delegated token is short-lived (spec §6): the access token never outlives this. */
export const MAX_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3_600;

/**
 * Longest reuse window of a rotated refresh token: the window tolerates two
 * honest processes renewing together, and is exactly what a thief has to
 * replay a stolen token unnoticed, so it stays a matter of seconds.
 */
export const MAX_OAUTH_REFRESH_REUSE_WINDOW_SECONDS = 60;

/**
 * The authorization server of the management door. The access token is capped
 * (a longer one is not "short-lived"), and a refresh token that expired before
 * the access token it renews would be useless.
 */
function readOAuth(r: Reader): OAuthConfig {
  const accessTokenTtlSeconds = r.duration('oauth.access_token_ttl', DEFAULTS.oauthAccessTokenTtl);
  const refreshTokenTtlSeconds = r.duration(
    'oauth.refresh_token_ttl',
    DEFAULTS.oauthRefreshTokenTtl,
  );
  if (accessTokenTtlSeconds > MAX_OAUTH_ACCESS_TOKEN_TTL_SECONDS) {
    r.issues.add(
      'oauth.access_token_ttl',
      'must be at most 1h: a delegated token is short-lived and renewed with its refresh token',
      envNamesFor('oauth.access_token_ttl'),
    );
  }
  if (refreshTokenTtlSeconds <= accessTokenTtlSeconds) {
    r.issues.add(
      'oauth.refresh_token_ttl',
      'must be longer than oauth.access_token_ttl',
      envNamesFor('oauth.refresh_token_ttl'),
    );
  }
  const refreshReuseWindowSeconds = r.int(
    'oauth.refresh_reuse_window_seconds',
    DEFAULTS.oauthRefreshReuseWindowSeconds,
    0,
  );
  if (refreshReuseWindowSeconds > MAX_OAUTH_REFRESH_REUSE_WINDOW_SECONDS) {
    r.issues.add(
      'oauth.refresh_reuse_window_seconds',
      `must be at most ${MAX_OAUTH_REFRESH_REUSE_WINDOW_SECONDS}: beyond that a replayed refresh token is treated as stolen`,
      envNamesFor('oauth.refresh_reuse_window_seconds'),
    );
  }
  return {
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
    refreshReuseWindowSeconds,
    clientRegistration: {
      policy: readClientRegistrationPolicy(r),
      autoApproveLoopback: r.bool(
        'oauth.client_registration.auto_approve_loopback',
        DEFAULTS.oauthAutoApproveLoopback,
      ),
      metadataDocuments: r.bool(
        'oauth.client_registration.metadata_documents',
        DEFAULTS.oauthMetadataDocuments,
      ),
    },
  };
}

function readClientRegistrationPolicy(r: Reader): ClientRegistrationPolicy {
  const path = 'oauth.client_registration.policy';
  const fallback: ClientRegistrationPolicy = DEFAULTS.oauthClientRegistrationPolicy;
  const policy = r.string(path, { fallback }) ?? fallback;
  if (isClientRegistrationPolicy(policy)) return policy;
  r.issues.add(
    path,
    `expected one of ${CLIENT_REGISTRATION_POLICIES.join(', ')}, got "${policy}"`,
    envNamesFor(path),
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

function readEncryption(r: Reader): EncryptionConfig | null {
  const path = 'encryption.master_key';
  const encoded = r.string(path, { required: true });
  const masterKey = encoded === undefined ? undefined : decodeKey(encoded, path, r.issues);
  const keyVersion = r.int('encryption.key_version', DEFAULTS.keyVersion);

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
  if (!masterKey) return null;
  return { masterKey, keyVersion, previousKeys };
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

function readIdp(r: Reader): IdpConfig | null {
  const block = r.tree('idp');
  if (!block || Object.keys(block).length === 0) return null;
  const issuer = r.url('idp.issuer', { required: true, https: true });
  const clientId = r.string('idp.client_id', { required: true });
  const clientSecret = r.string('idp.client_secret', { required: true });
  const claims = {
    sub: r.string('idp.claims.sub', { fallback: DEFAULTS.claimSub }) ?? DEFAULTS.claimSub,
    email: r.string('idp.claims.email', { fallback: DEFAULTS.claimEmail }) ?? DEFAULTS.claimEmail,
    groups:
      r.string('idp.claims.groups', { fallback: DEFAULTS.claimGroups }) ?? DEFAULTS.claimGroups,
  };
  const allowedEmailDomains = r.stringList('idp.allowed_email_domains').map((d) => d.toLowerCase());
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer, clientId, clientSecret, claims, allowedEmailDomains };
}

function readAdmin(r: Reader): AdminRule | null {
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
  if (group === null && emails.length === 0) {
    r.issues.add(
      'admin',
      'the admin rule needs admin.group (an IdP group name) or admin.emails (a non-empty list)',
      [...envNamesFor('admin.group'), ...envNamesFor('admin.emails')],
    );
    return null;
  }
  return { group, emails };
}

function readProviders(r: Reader): ReadonlyMap<string, ProviderAppConfig> {
  const out = new Map<string, ProviderAppConfig>();
  const block = r.tree('providers');
  if (!block) return out;
  for (const [providerId, value] of Object.entries(block)) {
    const base = `providers.${providerId}`;
    if (!isPlainObject(value)) {
      r.issues.add(base, `expected a mapping of app fields, got ${typeName(value)}`);
      continue;
    }
    const app: { -readonly [K in keyof ProviderAppConfig]?: string } = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      const path = `${base}.${field}`;
      if (!isProviderAppField(field)) {
        r.issues.add(
          path,
          `unknown provider app field; expected one of ${PROVIDER_APP_FIELDS.join(', ')}`,
        );
        continue;
      }
      if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
        r.issues.add(
          path,
          `expected a non-empty string, got ${typeName(fieldValue)}`,
          envNamesFor(path),
        );
        continue;
      }
      app[PROVIDER_APP_FIELD_PROPERTY[field]] = fieldValue;
    }
    out.set(providerId, app);
  }
  return out;
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
