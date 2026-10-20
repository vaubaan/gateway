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
  GITHUB_IS_NOT_OIDC,
  isGithubDotComHost,
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
  DEFAULT_LOCAL_PROVIDER_NAME,
  localProviderOf,
  type LocalSignInProvider,
} from '../config/sign-in';
import type { IdpClaimMapping, InstanceConfig } from '../config/types';
import type { ConfigRepo, ConfigWrite } from '../store/repositories/config';
import { IdpSettingsError } from './errors';
import { DEFAULT_CLAIM_MAPPING, IDP_CONFIG_KEYS, type IdpSettingsService } from './idp-settings';

/** A provider without its secret (the union kept: `kind` still tells the two apart). */
export type SignInProviderWithoutSecret =
  | Omit<OidcSignInProvider, 'clientSecret'>
  | Omit<GithubSignInProvider, 'clientSecret'>
  | LocalSignInProvider;

/** A provider as the pages and the authenticator see it: never its secret. */
export type SignInProviderView = SignInProviderWithoutSecret & {
  readonly source: SignInProviderSource;
  /**
   * Whether people may sign in through it (ADR administrators-live-in-the-instance,
   * §5): a provider of the configuration always; one saved in Settings once an
   * administrator enabled it after a passed test (local accounts: when added).
   */
  readonly enabled: boolean;
};

/** What a test of a provider beside the session found (`/auth/test/<id>`). */
export interface ProviderTestRecord {
  readonly at: string;
  /** The tester: a user id, or `bootstrap`. */
  readonly by: string;
  /** The web session that ran it: only that session acts on the result. */
  readonly sessionId: string;
  /** `passed`: the provider returned an identity the instance accepts as one. */
  readonly outcome: 'passed' | 'failed';
  /** The closed code of the failure (`LoginErrorCode`), and what the discovery said. */
  readonly error?: string;
  readonly detail?: string;
  readonly identity?: {
    readonly issuer: string;
    readonly subject: string;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly displayName: string | null;
    readonly groups: readonly string[];
    readonly amr?: readonly string[];
  };
  /** The sign-in it would give: admitted (and why), as administrator or not, or refused (and why). */
  readonly verdict?: {
    readonly admitted: boolean;
    readonly reason?: string;
    readonly refusal?: string;
    readonly administrator: boolean;
  };
}

/** The state of a provider saved in Settings: `sign_in_state.<id>` (absent: enabled). */
export interface ProviderState {
  readonly enabled: boolean;
  /** When its settings were last saved: a test before that is stale. */
  readonly changedAt: string | null;
  readonly test: ProviderTestRecord | null;
}

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
  /**
   * Fetches an OpenID Connect issuer's discovery document before the provider is
   * saved (`RelyingPartyFactory.checkIssuer`): `null` when it is valid, otherwise why
   * not. Absent: no check (unit tests of the other rules).
   */
  readonly checkIssuer?: (issuer: URL) => Promise<string | null>;
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

/** The JSON of `sign_in.<id>`: everything but the secret (a local provider: its name). */
interface StoredSettings {
  readonly kind: SignInKind;
  readonly name: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly claims?: IdpClaimMapping;
  readonly allowed_email_domains: readonly string[];
  readonly invitation_only: boolean;
  /** OpenID Connect only: `requireVerifiedEmail` (absent: false). */
  readonly require_verified_email?: boolean;
  readonly created_at: string;
}

/** What `carryIntoStore` wrote: the ids of the providers, never a secret. */
export interface CarriedSignIn {
  readonly providers: readonly string[];
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
  if (kind === 'local') {
    if (typeof name !== 'string' || typeof created_at !== 'string') return null;
    return {
      kind,
      name,
      issuer: '',
      client_id: '',
      allowed_email_domains: [],
      invitation_only: true,
      created_at,
    };
  }
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
      ? {
          sub: claims.sub,
          email: claims.email,
          groups: claims.groups,
          ...(typeof claims.emailVerified === 'string'
            ? { emailVerified: claims.emailVerified }
            : {}),
        }
      : undefined;
  return {
    kind,
    name,
    issuer,
    client_id,
    claims: parsedClaims,
    allowed_email_domains,
    invitation_only,
    ...(value.require_verified_email === true ? { require_verified_email: true } : {}),
    created_at,
  };
}

function toProvider(id: string, s: StoredSettings, clientSecret: string): SignInProvider | null {
  if (s.kind === 'local') return localProviderOf(id, s.name);
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
    : {
        kind: 'oidc',
        ...base,
        claims: s.claims ?? DEFAULT_CLAIM_MAPPING,
        ...(s.require_verified_email === true ? { requireVerifiedEmail: true } : {}),
      };
}

/** The JSON of `sign_in.<id>` for an OpenID Connect or GitHub provider. */
function storedSettingsOf(
  provider: OidcSignInProvider | GithubSignInProvider,
  createdAt: string,
): StoredSettings {
  return {
    kind: provider.kind,
    name: provider.name,
    issuer: provider.issuer.href,
    client_id: provider.clientId,
    ...(provider.kind === 'oidc' ? { claims: provider.claims } : {}),
    allowed_email_domains: provider.allowedEmailDomains,
    invitation_only: provider.invitationOnly,
    ...(provider.kind === 'oidc' && provider.requireVerifiedEmail === true
      ? { require_verified_email: true }
      : {}),
    created_at: createdAt,
  };
}

function viewOf(
  provider: SignInProvider,
  source: SignInProviderSource,
  enabled = true,
): SignInProviderView {
  if (provider.kind === 'local') return { ...provider, source, enabled };
  const { clientSecret: _secret, ...rest } = provider;
  return { ...rest, source, enabled };
}

const STATE_PREFIX = 'sign_in_state.';
function stateKey(id: string): string {
  return `${STATE_PREFIX}${id}`;
}

function parseState(raw: string | null): ProviderState {
  if (!raw) return { enabled: true, changedAt: null, test: null };
  try {
    const value = JSON.parse(raw) as {
      enabled?: unknown;
      changed_at?: unknown;
      test?: unknown;
    };
    return {
      enabled: value.enabled !== false,
      changedAt: typeof value.changed_at === 'string' ? value.changed_at : null,
      test:
        typeof value.test === 'object' && value.test !== null
          ? (value.test as ProviderTestRecord)
          : null,
    };
  } catch {
    return { enabled: true, changedAt: null, test: null };
  }
}

function serializeState(state: ProviderState): string {
  return JSON.stringify({
    enabled: state.enabled,
    changed_at: state.changedAt,
    ...(state.test ? { test: state.test } : {}),
  });
}

/** Whether a test passed since the provider was last saved: what enabling it needs. */
export function testPassedSinceSaved(state: ProviderState): boolean {
  const test = state.test;
  if (!test || test.outcome !== 'passed') return false;
  return state.changedAt === null || test.at >= state.changedAt;
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
    ...(provider.kind === 'local' ? {} : { client_id: provider.clientId }),
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
    /**
     * The groups designated without a provider (a bare `admin.group` carried over from
     * the configuration): they name the group of the one provider, so a change of the
     * provider list must not make them ambiguous or move them.
     */
    private readonly bareAdminGroups: () => Promise<readonly string[]>,
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
    const stored: SignInProviderView[] = [];
    for (const p of fromStore) stored.push(viewOf(p, 'store', (await this.state(p.id)).enabled));
    return [...fromFile, ...stored];
  }

  /** The state of a provider saved in Settings; a provider of the file is always enabled. */
  async state(id: string): Promise<ProviderState> {
    if (this.isReadOnly(id)) {
      return { ...parseState(await this.store.get(stateKey(id))), enabled: true };
    }
    return parseState(await this.store.get(stateKey(id)));
  }

  /** Records the outcome of a test beside the session; returns it. */
  async recordTest(id: string, test: ProviderTestRecord): Promise<void> {
    const current = parseState(await this.store.get(stateKey(id)));
    await this.store.set(stateKey(id), serializeState({ ...current, test }));
  }

  /**
   * Switches a provider saved in Settings on or off. On: only after a test that passed
   * since its last save (local accounts need none). A file provider cannot be switched.
   */
  async setEnabled(id: string, enabled: boolean): Promise<SignInProvider> {
    if (this.isReadOnly(id)) {
      throw new IdpSettingsError([
        `provider '${id}' is set by the mounted configuration; it is always on`,
      ]);
    }
    const existing = await this.resolve(id);
    if (!existing) throw new IdpSettingsError([`no sign-in provider has the id '${id}'`]);
    const current = await this.state(id);
    if (enabled && existing.provider.kind !== 'local' && !testPassedSinceSaved(current)) {
      throw new IdpSettingsError([
        'test it first: a provider is switched on after a test that passed since it was last saved',
      ]);
    }
    await this.store.set(stateKey(id), serializeState({ ...current, enabled }));
    return existing.provider;
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
    const result = await this.saveSettings(input, mode);
    // A new provider that redirects is saved off, and switched on after a passed
    // test; local accounts have nothing to test. An edit keeps the switch, and makes
    // the last test stale (ADR administrators-live-in-the-instance, §5).
    const current = parseState(await this.store.get(stateKey(result.saved.id)));
    await this.store.set(
      stateKey(result.saved.id),
      serializeState({
        enabled: result.before === null ? result.saved.kind === 'local' : current.enabled,
        changedAt: this.clock.now().toISOString(),
        test: current.test,
      }),
    );
    return result;
  }

  private async saveSettings(
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
    const others = (await this.views()).filter((p) => p.id !== id);
    if (kind === 'local') {
      // Nothing to register anywhere: an id and a name. One per instance.
      const twin = others.find((p) => p.kind === 'local');
      if (twin) {
        problems.push(
          `provider '${twin.id}' already keeps this gateway's local accounts: one local provider per instance`,
        );
      }
      problems.push(
        ...(await this.adminRuleChange(
          others.map((p) => p.id),
          [...others.map((p) => p.id), id],
        )),
      );
      if (problems.length > 0) throw new IdpSettingsError(problems);
      const saved = localProviderOf(id, input.name.trim() || DEFAULT_LOCAL_PROVIDER_NAME);
      const stored: StoredSettings = {
        kind: 'local',
        name: saved.name,
        issuer: '',
        client_id: '',
        allowed_email_domains: [],
        invitation_only: true,
        created_at: (await this.createdAt(id)) ?? this.clock.now().toISOString(),
      };
      await this.store.apply([
        { kind: 'value', key: settingsKey(id), value: JSON.stringify(stored) },
        { kind: 'delete', key: secretKey(id) },
      ]);
      return { saved, before };
    }
    const issuer = this.parseIssuer(kind, input.issuer, problems);
    const clientId = input.clientId.trim();
    if (clientId.length === 0) problems.push('client id is required');
    const given = input.clientSecret?.trim() || null;
    const issuerChanged =
      before !== null && issuer !== null && issuerKey(before.issuer) !== issuerKey(issuer);
    // A blank field keeps the stored secret — for the provider it was given for.
    const kept = before && before.kind !== 'local' ? before.clientSecret : null;
    const clientSecret = given ?? (issuerChanged ? null : kept);
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
    problems.push(
      ...(await this.adminRuleChange(
        others.map((p) => p.id),
        [...others.map((p) => p.id), id],
      )),
    );
    if (problems.length > 0 || !issuer || !clientSecret) throw new IdpSettingsError(problems);
    // Last, and only for a new issuer: the one check that reaches the network.
    if (kind === 'oidc' && (before === null || issuerChanged) && this.options.checkIssuer) {
      const discovery = await this.options.checkIssuer(issuer);
      if (discovery) throw new IdpSettingsError([discovery]);
    }

    const base = {
      id,
      name,
      issuer,
      clientId,
      clientSecret,
      allowedEmailDomains,
      invitationOnly: input.invitationOnly,
    };
    // The form shows neither: an edit keeps what the provider had (a carried
    // Entra provider must keep requiring a verified email).
    const keptOidc = before?.kind === 'oidc' ? before : null;
    const keptVerifiedClaim =
      keptOidc?.claims.emailVerified !== undefined
        ? { emailVerified: keptOidc.claims.emailVerified }
        : {};
    const saved: SignInProvider =
      kind === 'github'
        ? { kind: 'github', ...base }
        : {
            kind: 'oidc',
            ...base,
            claims: { ...(claims ?? DEFAULT_CLAIM_MAPPING), ...keptVerifiedClaim },
            ...(keptOidc?.requireVerifiedEmail === true ? { requireVerifiedEmail: true } : {}),
          };

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
    const stored = storedSettingsOf(
      saved,
      (await this.createdAt(id)) ?? this.clock.now().toISOString(),
    );
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
    const ruleProblems = await this.adminRuleChange([...remaining, id], remaining);
    if (ruleProblems.length > 0) throw new IdpSettingsError(ruleProblems);
    const writes: ConfigWrite[] =
      id === LEGACY_PROVIDER_ID
        ? Object.values(IDP_CONFIG_KEYS).map((key) => ({ kind: 'delete', key }))
        : [
            { kind: 'delete', key: settingsKey(id) },
            { kind: 'delete', key: secretKey(id) },
          ];
    writes.push({ kind: 'delete', key: stateKey(id) });
    await this.store.apply(writes);
    return existing.provider;
  }

  /**
   * Writes every provider the configuration sets into this store as store-held ones
   * (ADR backup-carries-the-sign-in-configuration). Run by the `backup` command on
   * its copy, never on a live store: the copy restored elsewhere signs people in as
   * the source did. The client secrets are sealed like any stored secret; the
   * provider `idp` goes to the single-provider keys. One transaction. The
   * administrators need no carrying: they are rows of the store being copied (ADR
   * administrators-live-in-the-instance), so no `restored.admin_rule` is written.
   */
  async carryIntoStore(): Promise<CarriedSignIn> {
    const writes: ConfigWrite[] = [];
    for (const provider of this.file) {
      writes.push(...(await this.carriedWritesOf(provider)));
    }
    await this.store.apply(writes);
    return { providers: this.file.map((p) => p.id) };
  }

  private async carriedWritesOf(provider: SignInProvider): Promise<ConfigWrite[]> {
    if (provider.kind === 'local') {
      const stored: StoredSettings = {
        kind: 'local',
        name: provider.name,
        issuer: '',
        client_id: '',
        allowed_email_domains: [],
        invitation_only: true,
        created_at: (await this.createdAt(provider.id)) ?? this.clock.now().toISOString(),
      };
      return [
        { kind: 'value', key: settingsKey(provider.id), value: JSON.stringify(stored) },
        { kind: 'delete', key: secretKey(provider.id) },
      ];
    }
    if (provider.id === LEGACY_PROVIDER_ID && provider.kind === 'oidc') {
      return [
        { kind: 'value', key: IDP_CONFIG_KEYS.issuer, value: provider.issuer.href },
        { kind: 'value', key: IDP_CONFIG_KEYS.clientId, value: provider.clientId },
        { kind: 'secret', key: IDP_CONFIG_KEYS.clientSecret, plain: provider.clientSecret },
        { kind: 'value', key: IDP_CONFIG_KEYS.claimSub, value: provider.claims.sub },
        { kind: 'value', key: IDP_CONFIG_KEYS.claimEmail, value: provider.claims.email },
        { kind: 'value', key: IDP_CONFIG_KEYS.claimGroups, value: provider.claims.groups },
        {
          kind: 'value',
          key: IDP_CONFIG_KEYS.allowedEmailDomains,
          value: JSON.stringify(provider.allowedEmailDomains),
        },
        {
          kind: 'value',
          key: IDP_CONFIG_KEYS.invitationOnly,
          value: String(provider.invitationOnly),
        },
      ];
    }
    const createdAt = (await this.createdAt(provider.id)) ?? this.clock.now().toISOString();
    return [
      {
        kind: 'value',
        key: settingsKey(provider.id),
        value: JSON.stringify(storedSettingsOf(provider, createdAt)),
      },
      { kind: 'secret', key: secretKey(provider.id), plain: provider.clientSecret },
    ];
  }

  /**
   * Refuses a change of the provider list that would leave an administrators' group
   * designated without a provider ambiguous, or make it name another provider's group
   * than it does now.
   */
  private async adminRuleChange(
    beforeIds: readonly string[],
    afterIds: readonly string[],
  ): Promise<string[]> {
    const problems: string[] = [];
    for (const raw of await this.bareAdminGroups()) {
      const before = resolveAdminGroup(raw, beforeIds);
      const after = resolveAdminGroup(raw, afterIds);
      if (after === null && afterIds.length > 1) {
        problems.push(
          `the administrators' group "${raw}" does not say which provider claims it, and this change leaves ${afterIds.length} providers: ` +
            `name the group with its provider first in Administration → Users (for instance "${before?.provider ?? afterIds[0] ?? LEGACY_PROVIDER_ID}:${before?.name ?? raw}"), then remove the one without`,
        );
      } else if (before !== null && after !== null && !sameGroup(before, after)) {
        problems.push(
          `this change would make the administrators' group "${raw}" mean the group "${after.name}" of provider '${after.provider}' instead of "${before.name}" of '${before.provider}': name the group with its provider first in Administration → Users`,
        );
      }
    }
    return problems;
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
    if (kind === 'oidc' && isGithubDotComHost(url)) {
      problems.push(GITHUB_IS_NOT_OIDC);
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
      // A local provider has no secret to read.
      const secret =
        withSecrets && settings.kind !== 'local' ? await this.store.getSecret(secretKey(id)) : '';
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
