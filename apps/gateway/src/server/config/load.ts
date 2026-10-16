/**
 * `loadInstanceConfig()` — the only way an `InstanceConfig` comes to exist.
 *
 * Precedence (ADR docker-image-and-config-format): the mounted YAML file wins
 * over environment variables, key by key. Validation collects every problem
 * and throws one `ConfigError` naming each YAML path and its variable(s).
 */
import { KEY_BYTES } from '../crypto/aead';
import { isClientIpHeader, isTrustedProxyEntry, type ClientIpHeader } from '../http/client-ip';
import { parseDuration } from './duration';
import { checkInstanceName, INSTANCE_NAME_PROBLEMS } from './instance-name';
import {
  admissionProblem,
  adminGroupProblem,
  GITHUB_DOT_COM,
  isSignInKind,
  isSignInProviderId,
  issuerKey,
  LEGACY_PROVIDER_ID,
  legacyProviderOf,
  normalizeEmailDomains,
  SIGN_IN_KINDS,
  type SignInProvider,
} from './sign-in';
import { ConfigError, IssueList } from './errors';
import { type EnvSource, type FileReader, defaultFileReader } from './secret-refs';
import { readSelfResources } from './self-resources';
import {
  type RawTree,
  envNamesFor,
  getPath,
  isKeyRequired,
  isPlainObject,
  keySpec,
  mergeTrees,
  readEnvSource,
  readFileSource,
  secretEnvVariables,
  SIGN_IN_ENV_PREFIX,
} from './sources';
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

/** `git.max_pack_mb` is in mebibytes. */
const BYTES_PER_MEGABYTE = 1024 * 1024;

/** The master key is the AEAD key: one size, defined by the crypto module. */
export const MASTER_KEY_BYTES = KEY_BYTES;
// Defaults and bounds are those of the key table (`KEYS` in `sources.ts`).
const MIN_BOOTSTRAP_TOKEN_LENGTH = keySpec('bootstrap_token').minLength;
const DEFAULT_LOG_LEVEL: LogLevel = keySpec('log.level').default;

interface IntKey {
  readonly path: string;
  readonly default: number;
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
}

export function loadInstanceConfig(options: LoadOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? defaultFileReader;
  const issues = new IssueList();

  const fromEnv = readEnvSource(env, issues, readFile);
  const fromFile = readFileSource(env, issues, readFile);
  const raw = fromFile ? mergeTrees(fromEnv, fromFile.tree) : fromEnv;
  const config = validate(raw, issues, env);
  issues.throwIfAny();
  if (!config) throw new ConfigError(issues.items); // unreachable: validate() reports every failure
  const secretEnvNames = [
    ...new Set([...secretEnvVariables(env), ...(fromFile?.secretVariables ?? [])]),
  ].sort();
  return { config, configFile: fromFile?.path ?? null, secretEnvNames };
}

/**
 * Loads the configuration from `process.env`, then deletes from `process.env` every
 * variable that carried a secret (the master keys, client secrets, private keys, the
 * bootstrap token, their `_FILE` paths, and the variables the YAML file references at a
 * secret key): the values live on in the returned configuration only, so a dump of
 * `process.env` or a child process sees none of them. What it cannot reach: the
 * process's initial environment block, which `/proc/<pid>/environ` keeps showing to its
 * own user and to root (ADR secrets-leave-the-process-environment-after-load).
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

function validate(raw: RawTree, issues: IssueList, env: EnvSource): InstanceConfig | null {
  const r = new Reader(raw, issues);
  const before = issues.items.length;

  const publicUrl = readPublicUrl(r);
  const instanceName = readInstanceName(r);
  const trustedProxies = readTrustedProxies(r);
  const selfResources = readSelfResources(r.stringList('self_resources'), env, (message) =>
    r.issues.add('self_resources', message, envNamesFor('self_resources')),
  );
  const clientIpHeader = readClientIpHeader(r, trustedProxies);
  const storePath = r.string('store.path', { required: isKeyRequired(keySpec('store.path')) });
  const encryption = readEncryption(r);
  const idp = readIdp(r);
  const signIn = readSignIn(r);
  const signInProviders = checkSignInProviders(r, idp, signIn);
  const admin = readAdmin(r, signInProviders);
  const providers = readProviders(r);
  const bootstrapToken = readBootstrapToken(r, signInProviders.length > 0);

  const telemetryEnabled = r.bool(keySpec('telemetry.enabled'));
  // A null or mistyped value is not a decision: only a boolean pins the toggle.
  const telemetrySetByConfig = typeof getPath(raw, 'telemetry.enabled') === 'boolean';
  const collector = keySpec('telemetry.collector_url');
  const collectorUrl = r.url(collector.path, {
    fallback: collector.default,
    https: collector.https,
  });

  const retentionDays = r.int(keySpec('retention_days'));
  const requestExpiry = r.duration(keySpec('requests.expiry'));
  const approvalExpiry = r.duration(keySpec('approvals.expiry'));
  const mcpRateLimit = r.int(keySpec('mcp.rate_limit_per_minute'));
  const gitMaxPackMb = r.int(keySpec('git.max_pack_mb'));
  const gitRequestTimeout = r.duration(keySpec('git.request_timeout'));
  const oauth = readOAuth(r);
  const level = readLogLevel(r);

  if (issues.items.length > before) return null;
  if (!publicUrl || !storePath || !encryption || !admin || !collectorUrl) return null;

  return {
    publicUrl,
    instanceName,
    trustedProxies,
    selfResources,
    clientIpHeader,
    store: { path: storePath },
    encryption,
    idp,
    signIn,
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
    git: {
      maxPackBytes: gitMaxPackMb * BYTES_PER_MEGABYTE,
      requestTimeoutSeconds: gitRequestTimeout,
    },
    oauth,
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

/** A delegated token is short-lived (spec §6): the access token never outlives this. */
export const MAX_OAUTH_ACCESS_TOKEN_TTL_SECONDS = keySpec('oauth.access_token_ttl').maxSeconds;

/**
 * Longest reuse window of a rotated refresh token: the window tolerates two
 * honest processes renewing together, and is exactly what a thief has to
 * replay a stolen token unnoticed, so it stays a matter of seconds.
 */
export const MAX_OAUTH_REFRESH_REUSE_WINDOW_SECONDS = keySpec(
  'oauth.refresh_reuse_window_seconds',
).max;

/**
 * The authorization server of the management door. The access token is capped
 * (a longer one is not "short-lived"), and a refresh token that expired before
 * the access token it renews would be useless.
 */
function readOAuth(r: Reader): OAuthConfig {
  const accessTokenTtlSeconds = r.duration(keySpec('oauth.access_token_ttl'));
  const refreshTokenTtlSeconds = r.duration(keySpec('oauth.refresh_token_ttl'));
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
  const delegationMaxLifetimeSeconds = r.duration(keySpec('oauth.delegation_max_lifetime'));
  if (delegationMaxLifetimeSeconds <= accessTokenTtlSeconds) {
    r.issues.add(
      'oauth.delegation_max_lifetime',
      'must be longer than oauth.access_token_ttl: a delegation that ends before its first token is useless',
      envNamesFor('oauth.delegation_max_lifetime'),
    );
  }
  const refreshReuseWindowSeconds = r.int(keySpec('oauth.refresh_reuse_window_seconds'));
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
    delegationMaxLifetimeSeconds,
    refreshReuseWindowSeconds,
    clientRegistration: {
      policy: readClientRegistrationPolicy(r),
      autoApproveLoopback: r.bool(keySpec('oauth.client_registration.auto_approve_loopback')),
      metadataDocuments: r.bool(keySpec('oauth.client_registration.metadata_documents')),
    },
  };
}

function readClientRegistrationPolicy(r: Reader): ClientRegistrationPolicy {
  const path = 'oauth.client_registration.policy';
  const fallback: ClientRegistrationPolicy = keySpec(path).default;
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
  const encoded = r.string(path, { required: isKeyRequired(keySpec(path)) });
  const masterKey = encoded === undefined ? undefined : decodeKey(encoded, path, r.issues);
  const keyVersion = r.int(keySpec('encryption.key_version'));

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
  // The block exists: its three connection keys are now required.
  const issuerKey = keySpec('idp.issuer');
  const issuer = r.url(issuerKey.path, {
    required: isKeyRequired(issuerKey, true),
    https: issuerKey.https,
  });
  const clientId = r.string('idp.client_id', {
    required: isKeyRequired(keySpec('idp.client_id'), true),
  });
  const clientSecret = r.string('idp.client_secret', {
    required: isKeyRequired(keySpec('idp.client_secret'), true),
  });
  const claims = {
    sub: r.text(keySpec('idp.claims.sub')),
    email: r.text(keySpec('idp.claims.email')),
    groups: r.text(keySpec('idp.claims.groups')),
  };
  const allowedEmailDomains = r.stringList('idp.allowed_email_domains').map((d) => d.toLowerCase());
  const invitationOnly = r.bool(keySpec('idp.invitation_only'));
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer, clientId, clientSecret, claims, allowedEmailDomains, invitationOnly };
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
 * The rules across the providers the configuration sets: one id each (`idp.*` is
 * the provider `idp`), one issuer each (a user is (issuer, subject): two providers
 * of one issuer would be one population with two admission rules), and an
 * admission rule for every open provider.
 */
function checkSignInProviders(
  r: Reader,
  idp: IdpConfig | null,
  signIn: readonly SignInProvider[],
): SignInProvider[] {
  const all = [...(idp ? [legacyProviderOf(idp)] : []), ...signIn];
  const issuers = new Map<string, string>();
  for (const provider of all) {
    const path = provider.id === LEGACY_PROVIDER_ID && idp ? 'idp' : `sign_in.${provider.id}`;
    if (
      provider.id === LEGACY_PROVIDER_ID &&
      idp &&
      signIn.some((p) => p.id === LEGACY_PROVIDER_ID)
    ) {
      r.issues.add(
        'sign_in.idp',
        "the id 'idp' is the provider the idp.* keys describe; set one or the other",
      );
    }
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
      r.issues.add(
        provider.id === LEGACY_PROVIDER_ID && idp
          ? 'idp.allowed_email_domains'
          : `${path}.allowed_email_domains`,
        problem,
        provider.id === LEGACY_PROVIDER_ID && idp
          ? [...envNamesFor('idp.allowed_email_domains'), ...envNamesFor('idp.invitation_only')]
          : [
              ...envNamesFor(`${path}.allowed_email_domains`),
              ...envNamesFor(`${path}.invitation_only`),
            ],
      );
    }
  }
  return all;
}

function readAdmin(r: Reader, signInProviders: readonly SignInProvider[]): AdminRule | null {
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
