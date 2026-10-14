/**
 * The sign-in providers of the instance (spec §0 "Identity provider", §4.2
 * Settings → Sign-in, §4.3; ADR sign-in-providers-admission-and-admin-rule).
 *
 * Two sources, merged by id:
 *
 * - `file` — the mounted configuration and the environment (`idp.*` as the
 *   provider `idp`, `sign_in.<id>.*`). Read-only in the interface; it wins over a
 *   saved provider of the same id.
 * - `store` — saved by an administrator in Settings → Sign-in. The provider `idp`
 *   keeps the keys of the single-provider settings (`IdpSettingsService`,
 *   `idp.*` in `instance_config`); any other is `sign_in.<id>` (its settings, as
 *   JSON) and `sign_in.<id>.client_secret` (sealed by the `Encryptor`, associated
 *   data `instance_config:sign_in.<id>.client_secret`).
 *
 * `views()` never decrypts a secret: it is what the authenticator reads on every
 * request (which providers exist, their issuers) and what the pages show.
 * `resolve(id)` returns the provider with its client secret, for a sign-in.
 */
import {
  admissionProblem,
  fileSignInProviders,
  GITHUB_DOT_COM,
  isSignInKind,
  isSignInProviderId,
  issuerKey,
  LEGACY_PROVIDER_ID,
  legacyProviderOf,
  normalizeEmailDomains,
  resolveAdminGroup,
  type AdminGroup,
  type GithubSignInProvider,
  type OidcSignInProvider,
  type SignInKind,
  type SignInProvider,
  type SignInProviderSource,
} from '../config/sign-in';
import type { AdminRule, IdpClaimMapping, InstanceConfig } from '../config/types';
import type { ConfigRepo, ConfigWrite } from '../store/repositories/config';
import { resolveAdminRule, type ResolvedAdminRule } from './admin-rule';
import { IdpSettingsError } from './errors';
import { DEFAULT_CLAIM_MAPPING, IDP_CONFIG_KEYS, type IdpSettingsService } from './idp-settings';

/** A provider without its secret (the union kept: `kind` still tells the two apart). */
export type SignInProviderWithoutSecret =
  | Omit<OidcSignInProvider, 'clientSecret'>
  | Omit<GithubSignInProvider, 'clientSecret'>;

/** A provider as the pages and the authenticator see it: never its secret. */
export type SignInProviderView = SignInProviderWithoutSecret & {
  readonly source: SignInProviderSource;
};

/** A provider with its secret, for a sign-in. */
export interface EffectiveSignInProvider {
  readonly provider: SignInProvider;
  readonly source: SignInProviderSource;
}

/** What the Settings form sends. */
export interface SignInProviderInput {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  /** OpenID Connect: required. GitHub: blank for github.com, or a GitHub Enterprise Server URL. */
  readonly issuer: string;
  readonly clientId: string;
  /** `null` keeps the secret already stored for the same issuer. */
  readonly clientSecret: string | null;
  /** OpenID Connect only. */
  readonly claims?: IdpClaimMapping;
  readonly allowedEmailDomains: readonly string[];
  readonly invitationOnly: boolean;
}

export type SaveMode = 'create' | 'update';

export interface SignInProvidersOptions {
  /** Tests only: accept an `http://` issuer for the in-process providers. */
  readonly allowInsecureIssuer?: boolean;
}

const KEY_PREFIX = 'sign_in.';
const SECRET_SUFFIX = '.client_secret';
const SETTINGS_KEY = /^sign_in\.([a-z][a-z0-9-]{0,31})$/;

function settingsKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}
function secretKey(id: string): string {
  return `${KEY_PREFIX}${id}${SECRET_SUFFIX}`;
}

/** The JSON of `sign_in.<id>`: everything but the secret. */
interface StoredSettings {
  readonly kind: SignInKind;
  readonly name: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly claims?: IdpClaimMapping;
  readonly allowed_email_domains: readonly string[];
  readonly invitation_only: boolean;
  readonly created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStored(raw: string): StoredSettings | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { kind, name, issuer, client_id, allowed_email_domains, invitation_only, created_at } =
    value;
  if (
    typeof kind !== 'string' ||
    !isSignInKind(kind) ||
    typeof name !== 'string' ||
    typeof issuer !== 'string' ||
    typeof client_id !== 'string' ||
    !Array.isArray(allowed_email_domains) ||
    !allowed_email_domains.every((d) => typeof d === 'string') ||
    typeof invitation_only !== 'boolean' ||
    typeof created_at !== 'string'
  ) {
    return null;
  }
  const claims = value.claims;
  const parsedClaims =
    isRecord(claims) &&
    typeof claims.sub === 'string' &&
    typeof claims.email === 'string' &&
    typeof claims.groups === 'string'
      ? { sub: claims.sub, email: claims.email, groups: claims.groups }
      : undefined;
  return {
    kind,
    name,
    issuer,
    client_id,
    claims: parsedClaims,
    allowed_email_domains,
    invitation_only,
    created_at,
  };
}

function toProvider(id: string, s: StoredSettings, clientSecret: string): SignInProvider | null {
  let issuer: URL;
  try {
    issuer = new URL(s.issuer);
  } catch {
    return null;
  }
  const base = {
    id,
    name: s.name,
    issuer,
    clientId: s.client_id,
    clientSecret,
    allowedEmailDomains: s.allowed_email_domains,
    invitationOnly: s.invitation_only,
  };
  return s.kind === 'github'
    ? { kind: 'github', ...base }
    : { kind: 'oidc', ...base, claims: s.claims ?? DEFAULT_CLAIM_MAPPING };
}

function viewOf(provider: SignInProvider, source: SignInProviderSource): SignInProviderView {
  const { clientSecret: _secret, ...rest } = provider;
  return { ...rest, source };
}

/** What an administrative audit entry records of a provider: never the secret. */
export function signInProviderAuditView(
  provider: SignInProviderWithoutSecret,
): Record<string, unknown> {
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    issuer: provider.issuer.href,
    client_id: provider.clientId,
    ...(provider.kind === 'oidc' ? { claims: provider.claims } : {}),
    allowed_email_domains: provider.allowedEmailDomains,
    invitation_only: provider.invitationOnly,
  };
}

/** The audit object id of a provider's settings: `sign-in:<id>` (`idp` keeps the id `idp`). */
export function signInAuditObjectId(id: string): string {
  return id === LEGACY_PROVIDER_ID ? 'idp' : `sign-in:${id}`;
}

function sameGroup(a: AdminGroup | null, b: AdminGroup | null): boolean {
  return a?.provider === b?.provider && a?.name === b?.name;
}

export class SignInProvidersService {
  private readonly file: readonly SignInProvider[];

  constructor(
    config: Pick<InstanceConfig, 'idp' | 'signIn'>,
    private readonly rule: AdminRule,
    private readonly legacy: IdpSettingsService,
    private readonly store: ConfigRepo,
    private readonly clock: { now(): Date },
    private readonly options: SignInProvidersOptions = {},
  ) {
    this.file = fileSignInProviders(config);
  }

  /** Every provider, the file's first, without secrets. */
  async views(): Promise<SignInProviderView[]> {
    const fromFile = this.file.map((p) => viewOf(p, 'file'));
    const fileIds = new Set(this.file.map((p) => p.id));
    const fromStore = (await this.storedProviders(false)).filter((p) => !fileIds.has(p.id));
    return [...fromFile, ...fromStore.map((p) => viewOf(p, 'store'))];
  }

  async view(id: string): Promise<SignInProviderView | null> {
    return (await this.views()).find((p) => p.id === id) ?? null;
  }

  /** The provider with its client secret, or `null` when no provider has this id. */
  async resolve(id: string): Promise<EffectiveSignInProvider | null> {
    const fromFile = this.file.find((p) => p.id === id);
    if (fromFile) return { provider: fromFile, source: 'file' };
    const stored = (await this.storedProviders(true)).find((p) => p.id === id);
    return stored ? { provider: stored, source: 'store' } : null;
  }

  /** The provider whose users are recorded under `issuer` (a user's `users.issuer`). */
  async ofIssuer(issuer: string | null): Promise<SignInProviderView | null> {
    if (issuer === null) return null;
    const key = issuerKey(issuer);
    return (await this.views()).find((p) => issuerKey(p.issuer) === key) ?? null;
  }

  /** The admin rule against the providers configured now. */
  async adminRule(): Promise<ResolvedAdminRule> {
    const ids = (await this.views()).map((p) => p.id);
    return resolveAdminRule(this.rule, ids);
  }

  isReadOnly(id: string): boolean {
    return this.file.some((p) => p.id === id);
  }

  /**
   * Validates every field at once (`IdpSettingsError.problems`) and saves the
   * provider in one transaction. Returns what was saved and what it replaced.
   */
  async save(
    input: SignInProviderInput,
    mode: SaveMode,
  ): Promise<{ saved: SignInProvider; before: SignInProvider | null }> {
    const problems: string[] = [];
    const id = input.id.trim();
    if (!isSignInProviderId(id)) {
      problems.push(
        'the id is a lower-case letter, then letters, digits or hyphens (at most 32); it appears in the callback address',
      );
      throw new IdpSettingsError(problems);
    }
    if (this.isReadOnly(id)) {
      throw new IdpSettingsError([
        `provider '${id}' is set by the mounted configuration; edit it there`,
      ]);
    }
    const existing = await this.resolve(id);
    if (mode === 'create' && existing) {
      throw new IdpSettingsError([`a sign-in provider with the id '${id}' already exists`]);
    }
    if (mode === 'update' && !existing) {
      throw new IdpSettingsError([`no sign-in provider has the id '${id}'`]);
    }
    const before = existing?.provider ?? null;
    const kind = input.kind.trim();
    if (!isSignInKind(kind)) {
      throw new IdpSettingsError([`the kind must be OpenID Connect or GitHub, not '${kind}'`]);
    }
    if (before && before.kind !== kind) {
      problems.push('the kind of a provider cannot change: remove it and add another');
    }
    if (id === LEGACY_PROVIDER_ID && kind !== 'oidc') {
      problems.push(`the id '${LEGACY_PROVIDER_ID}' is kept for an OpenID Connect provider`);
    }
    const issuer = this.parseIssuer(kind, input.issuer, problems);
    const clientId = input.clientId.trim();
    if (clientId.length === 0) problems.push('client id is required');
    const given = input.clientSecret?.trim() || null;
    const issuerChanged =
      before !== null && issuer !== null && issuerKey(before.issuer) !== issuerKey(issuer);
    // A blank field keeps the stored secret — for the provider it was given for.
    const clientSecret = given ?? (issuerChanged ? null : (before?.clientSecret ?? null));
    if (!clientSecret) {
      problems.push(
        issuerChanged
          ? 'client secret is required when the issuer changes: the stored secret belongs to the previous provider'
          : 'client secret is required',
      );
    }
    const claims = kind === 'oidc' ? normalizeClaims(input.claims, problems) : undefined;
    const allowedEmailDomains = normalizeEmailDomains(input.allowedEmailDomains, problems);
    const name = input.name.trim() || (kind === 'github' ? 'GitHub' : (issuer?.hostname ?? id));
    const others = (await this.views()).filter((p) => p.id !== id);
    if (issuer) {
      const admission = admissionProblem({
        id,
        kind,
        issuer,
        allowedEmailDomains,
        invitationOnly: input.invitationOnly,
      });
      if (admission) problems.push(admission);
      const twin = others.find((p) => issuerKey(p.issuer) === issuerKey(issuer));
      if (twin) {
        problems.push(
          `provider '${twin.id}' already signs people in through ${issuerKey(issuer)}: a person is (issuer, subject), so one issuer is one provider`,
        );
      }
    }
    const ruleProblem = this.adminRuleChange(
      others.map((p) => p.id),
      [...others.map((p) => p.id), id],
    );
    if (ruleProblem) problems.push(ruleProblem);
    if (problems.length > 0 || !issuer || !clientSecret) throw new IdpSettingsError(problems);

    const base = {
      id,
      name,
      issuer,
      clientId,
      clientSecret,
      allowedEmailDomains,
      invitationOnly: input.invitationOnly,
    };
    const saved: SignInProvider =
      kind === 'github'
        ? { kind: 'github', ...base }
        : { kind: 'oidc', ...base, claims: claims ?? DEFAULT_CLAIM_MAPPING };

    if (id === LEGACY_PROVIDER_ID && saved.kind === 'oidc') {
      // The single-provider keys: what an instance saved before several providers existed.
      const legacy = await this.legacy.save({
        issuer: saved.issuer.href,
        clientId,
        clientSecret,
        claims: saved.claims,
        allowedEmailDomains,
        invitationOnly: input.invitationOnly,
      });
      return { saved: legacyProviderOf(legacy), before };
    }
    const stored: StoredSettings = {
      kind: saved.kind,
      name,
      issuer: saved.issuer.href,
      client_id: clientId,
      ...(saved.kind === 'oidc' ? { claims: saved.claims } : {}),
      allowed_email_domains: allowedEmailDomains,
      invitation_only: input.invitationOnly,
      created_at: (await this.createdAt(id)) ?? this.clock.now().toISOString(),
    };
    // One transaction: never the settings of one provider with the secret of another.
    await this.store.apply([
      { kind: 'value', key: settingsKey(id), value: JSON.stringify(stored) },
      { kind: 'secret', key: secretKey(id), plain: clientSecret },
    ]);
    return { saved, before };
  }

  /** Removes a provider saved in Settings; returns it. A file provider cannot be removed here. */
  async remove(id: string): Promise<SignInProvider> {
    if (this.isReadOnly(id)) {
      throw new IdpSettingsError([
        `provider '${id}' is set by the mounted configuration; remove it there`,
      ]);
    }
    const existing = await this.resolve(id);
    if (!existing) throw new IdpSettingsError([`no sign-in provider has the id '${id}'`]);
    const remaining = (await this.views()).map((p) => p.id).filter((other) => other !== id);
    const ruleProblem = this.adminRuleChange([...remaining, id], remaining);
    if (ruleProblem) throw new IdpSettingsError([ruleProblem]);
    const writes: ConfigWrite[] =
      id === LEGACY_PROVIDER_ID
        ? Object.values(IDP_CONFIG_KEYS).map((key) => ({ kind: 'delete', key }))
        : [
            { kind: 'delete', key: settingsKey(id) },
            { kind: 'delete', key: secretKey(id) },
          ];
    await this.store.apply(writes);
    return existing.provider;
  }

  /**
   * Refuses a change of the provider list that would leave the admin rule's group
   * ambiguous, or make it name another provider's group than it does now.
   */
  private adminRuleChange(
    beforeIds: readonly string[],
    afterIds: readonly string[],
  ): string | null {
    const raw = this.rule.group;
    if (raw === null) return null;
    const before = resolveAdminGroup(raw, beforeIds);
    const after = resolveAdminGroup(raw, afterIds);
    if (after === null && afterIds.length > 1) {
      return (
        `the admin rule's group "${raw}" does not say which provider claims it, and this change leaves ${afterIds.length} providers: ` +
        `write admin.group as "<provider>:<group>" in the configuration first (for instance "${before?.provider ?? afterIds[0] ?? LEGACY_PROVIDER_ID}:${before?.name ?? raw}")`
      );
    }
    if (before !== null && after !== null && !sameGroup(before, after)) {
      return `this change would make the admin rule's group "${raw}" mean the group "${after.name}" of provider '${after.provider}' instead of "${before.name}" of '${before.provider}': change admin.group first`;
    }
    return null;
  }

  private parseIssuer(kind: SignInKind, raw: string, problems: string[]): URL | null {
    const text = raw.trim() || (kind === 'github' ? GITHUB_DOT_COM : '');
    if (text.length === 0) {
      problems.push('issuer is required');
      return null;
    }
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      problems.push(
        kind === 'github' ? 'the GitHub address must be a URL' : 'issuer must be a URL',
      );
      return null;
    }
    if (
      url.protocol !== 'https:' &&
      !(this.options.allowInsecureIssuer && url.protocol === 'http:')
    ) {
      problems.push('issuer must use https');
      return null;
    }
    if (url.search || url.hash) {
      problems.push('issuer must not carry a query string or fragment');
      return null;
    }
    return url;
  }

  private async createdAt(id: string): Promise<string | null> {
    const raw = await this.store.get(settingsKey(id));
    return raw ? (parseStored(raw)?.created_at ?? null) : null;
  }

  /**
   * The providers saved in Settings, in the order they were added; the provider
   * `idp` (the single-provider keys) first. With `withSecrets` false the secret is
   * an empty string and never decrypted.
   */
  private async storedProviders(withSecrets: boolean): Promise<SignInProvider[]> {
    const out: { provider: SignInProvider; createdAt: string }[] = [];
    if (!this.legacy.readOnly) {
      const legacy = withSecrets ? await this.legacy.current() : null;
      const stored = withSecrets ? null : await this.legacy.stored();
      if (legacy) out.push({ provider: legacyProviderOf(legacy.settings), createdAt: '' });
      if (stored) {
        out.push({
          provider: legacyProviderOf({ ...stored, clientSecret: '' }),
          createdAt: '',
        });
      }
    }
    for (const key of await this.store.keys()) {
      const match = SETTINGS_KEY.exec(key);
      if (!match) continue;
      const id = match[1] ?? '';
      if (id === LEGACY_PROVIDER_ID) continue;
      const raw = await this.store.get(key);
      const settings = raw ? parseStored(raw) : null;
      if (!settings) continue;
      const secret = withSecrets ? await this.store.getSecret(secretKey(id)) : '';
      if (secret === null) continue;
      const provider = toProvider(id, settings, secret);
      if (provider) out.push({ provider, createdAt: settings.created_at });
    }
    return out
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((entry) => entry.provider);
  }
}

function normalizeClaims(claims: IdpClaimMapping | undefined, problems: string[]): IdpClaimMapping {
  const given = claims ?? DEFAULT_CLAIM_MAPPING;
  const out = { sub: given.sub.trim(), email: given.email.trim(), groups: given.groups.trim() };
  for (const [name, value] of Object.entries(out)) {
    if (value.length === 0) problems.push(`claim name for '${name}' is required`);
  }
  return out;
}
