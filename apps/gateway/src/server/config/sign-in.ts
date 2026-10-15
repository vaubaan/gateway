/**
 * Sign-in providers (spec §0 "Identity provider", "Open provider"; §4.3; ADR
 * sign-in-providers-admission-and-admin-rule). Pure definitions shared by the
 * configuration loader (providers from the mounted file and the environment)
 * and the authentication module (providers an administrator saved in
 * Settings → Sign-in): the provider id grammar, the issuer every user of a
 * provider is keyed by, which issuers anyone in the world holds an account at,
 * the admission rule an open provider must have, and how the admin rule's
 * group names its provider.
 *
 * This file is the one place of the server that names public identity
 * providers by address (`OPEN_ISSUERS`, `GITHUB_DOT_COM`): what makes them
 * open is a fact about those services, not a setting.
 */
import type { IdpClaimMapping } from './types';

export const SIGN_IN_KINDS = ['oidc', 'github'] as const;
export type SignInKind = (typeof SIGN_IN_KINDS)[number];

export function isSignInKind(raw: string): raw is SignInKind {
  return (SIGN_IN_KINDS as readonly string[]).includes(raw);
}

/**
 * The id of the provider the single-provider keys (`idp.*`, `VAUBAAN_IDP_*`) and the
 * settings saved before several providers existed describe. Its callback stays the
 * one an identity provider already has registered: `<public_url>/auth/callback`.
 */
export const LEGACY_PROVIDER_ID = 'idp';

/** Lower-case letter first, then letters, digits and hyphens; at most 32 characters. */
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function isSignInProviderId(raw: string): boolean {
  return PROVIDER_ID.test(raw);
}

/** github.com: the issuer of a GitHub provider without a GitHub Enterprise Server base URL. */
export const GITHUB_DOT_COM = 'https://github.com';
/** github.com serves its REST API from its own host; a GitHub Enterprise Server from `/api/v3`. */
export const GITHUB_DOT_COM_API = 'https://api.github.com';

interface SignInProviderBase {
  /** Stable slug: the login and callback paths, the admin rule's prefix, group ownership. */
  readonly id: string;
  /** What the sign-in button says: "Continue with <name>". */
  readonly name: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Lower-cased. Empty: see `admitsEveryone`. */
  readonly allowedEmailDomains: readonly string[];
  /** Only invited addresses (and the admin emails) are admitted, whatever the domain. */
  readonly invitationOnly: boolean;
}

export interface OidcSignInProvider extends SignInProviderBase {
  readonly kind: 'oidc';
  /** Discovery runs against `<issuer>/.well-known/openid-configuration`. */
  readonly issuer: URL;
  readonly claims: IdpClaimMapping;
  /**
   * Admit only an email the provider says it verified (`claims.email_verified` is
   * `true`), as for an open provider, although this one is a company directory. For
   * an admin rule by email on Entra ID, whose `email` claim a tenant's user
   * administrators can set to anything (ADR verified-email-for-a-company-directory).
   * Absent: `false`.
   */
  readonly requireVerifiedEmail?: boolean;
}

export interface GithubSignInProvider extends SignInProviderBase {
  readonly kind: 'github';
  /** `https://github.com`, or the base URL of a GitHub Enterprise Server. */
  readonly issuer: URL;
}

export type SignInProvider = OidcSignInProvider | GithubSignInProvider;

/** Where a provider comes from: the mounted configuration (read-only) or Settings → Sign-in. */
export type SignInProviderSource = 'file' | 'store';

/**
 * The issuer a user of this provider is recorded under (`users.issuer` is compared
 * with it): the URL without a trailing slash. An ID token's `iss` is compared the
 * same way, so `https://idp.example.com/` and its `iss` `https://idp.example.com`
 * are one issuer.
 */
export function issuerKey(issuer: URL | string): string {
  const href = typeof issuer === 'string' ? issuer : issuer.href;
  return href.replace(/\/+$/, '');
}

/** The REST API base of a GitHub provider: api.github.com, or `<base>/api/v3` for a GHES. */
export function githubApiBase(issuer: URL): URL {
  if (issuerKey(issuer) === GITHUB_DOT_COM) return new URL(GITHUB_DOT_COM_API);
  return new URL(`${issuerKey(issuer)}/api/v3`);
}

/**
 * Issuers anyone in the world can hold an account at, by the issuer identifier
 * the provider documents. Google accounts: every Gmail address and any address
 * someone verified there. Microsoft: the tenant of personal accounts, and the
 * multi-tenant endpoints that accept any organisation.
 */
const OPEN_ISSUERS: readonly string[] = [
  'https://accounts.google.com',
  'https://login.microsoftonline.com/common/v2.0',
  'https://login.microsoftonline.com/organizations/v2.0',
  'https://login.microsoftonline.com/consumers/v2.0',
  'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
];

/**
 * Whether anyone in the world may hold an account at this provider. A GitHub
 * provider always is (an Enterprise Server too: whether it allows sign-up is not
 * the instance's to know, so it is treated as open). An OpenID Connect provider
 * is open when its issuer is one of `OPEN_ISSUERS`; any other (an Entra tenant,
 * Okta, Keycloak, a company's Workspace through its own issuer) is the company's
 * directory.
 */
export function isOpenProvider(provider: Pick<SignInProvider, 'kind' | 'issuer'>): boolean {
  if (provider.kind === 'github') return true;
  return OPEN_ISSUERS.includes(issuerKey(provider.issuer));
}

/**
 * A provider admits everyone it authenticates only when it is a company
 * directory (not open), has no allowed domain and is not "invited only".
 */
export function admitsEveryone(
  provider: Pick<SignInProvider, 'kind' | 'issuer' | 'allowedEmailDomains' | 'invitationOnly'>,
): boolean {
  return (
    !isOpenProvider(provider) &&
    provider.allowedEmailDomains.length === 0 &&
    !provider.invitationOnly
  );
}

/**
 * The problem with a provider's admission rule, or `null`. An open provider with
 * neither allowed domains nor "invited only" would admit anybody on the internet:
 * refused when the configuration is loaded and when the form is saved.
 */
export function admissionProblem(
  provider: Pick<
    SignInProvider,
    'id' | 'kind' | 'issuer' | 'allowedEmailDomains' | 'invitationOnly'
  >,
): string | null {
  if (provider.invitationOnly && provider.allowedEmailDomains.length > 0) {
    return (
      `provider '${provider.id}' is set to admit invited addresses only and also lists allowed email domains: ` +
      'choose one — the domains (invited addresses are admitted besides them), or invited addresses only'
    );
  }
  if (!isOpenProvider(provider)) return null;
  if (provider.allowedEmailDomains.length > 0 || provider.invitationOnly) return null;
  return (
    `anyone can hold an account at ${issuerKey(provider.issuer)}, so provider '${provider.id}' needs an admission rule: ` +
    'list allowed email domains, or admit invited addresses only (the admin emails are always admitted)'
  );
}

/** Normalises a list of email domains; each problem is appended to `problems`. */
export function normalizeEmailDomains(domains: readonly string[], problems: string[]): string[] {
  const out: string[] = [];
  for (const raw of domains) {
    const domain = raw.trim().toLowerCase();
    if (domain.length === 0) continue;
    if (domain.includes('@') || /\s/.test(domain)) {
      problems.push(`'${domain}' is not a domain name`);
      continue;
    }
    if (!out.includes(domain)) out.push(domain);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* The admin rule's group                                                    */
/* ------------------------------------------------------------------------ */

/** A group of the admin rule, once it is known which provider claims it. */
export interface AdminGroup {
  readonly provider: string;
  readonly name: string;
}

const QUALIFIED_GROUP = /^([a-z][a-z0-9-]{0,31}):(.+)$/;

/** `github:acme/admins` → `{ prefix: 'github', name: 'acme/admins' }`; `null` without a slug prefix. */
export function splitAdminGroup(raw: string): { prefix: string; name: string } | null {
  const match = QUALIFIED_GROUP.exec(raw);
  if (!match) return null;
  const [, prefix = '', name = ''] = match;
  return { prefix, name };
}

/**
 * Which provider's group the rule names, given the providers configured now:
 *
 * - `<provider>:<group>` with a configured provider id → that provider's group;
 * - otherwise the whole value is a group name, and it belongs to the one provider
 *   when exactly one is configured — except that a value written as
 *   `<provider>:<group>` whose provider is not configured names nobody, unless the
 *   one provider is `idp` (the single provider of earlier versions, whose group
 *   names may contain a colon): a rule written for a provider that was removed
 *   must not fall to another one;
 * - with several providers and no provider named, the rule is ambiguous and
 *   matches nobody (`null`): a group claimed by provider A never satisfies a rule
 *   meant for provider B.
 */
export function resolveAdminGroup(
  raw: string | null,
  providerIds: readonly string[],
): AdminGroup | null {
  if (raw === null) return null;
  const split = splitAdminGroup(raw);
  if (split && providerIds.includes(split.prefix)) {
    return { provider: split.prefix, name: split.name };
  }
  const [only, ...others] = providerIds;
  if (only === undefined || others.length > 0) return null;
  if (split && only !== LEGACY_PROVIDER_ID) return null;
  return { provider: only, name: raw };
}

/**
 * Why the admin rule's group cannot be resolved against these providers, or `null`.
 * No group, or no provider yet (the bootstrap token decides), is not a problem.
 */
export function adminGroupProblem(
  raw: string | null,
  providerIds: readonly string[],
): string | null {
  if (raw === null || providerIds.length === 0) return null;
  if (resolveAdminGroup(raw, providerIds) !== null) return null;
  return (
    `the admin rule's group "${raw}" does not say which sign-in provider claims it, and there are ${providerIds.length} ` +
    `(${providerIds.join(', ')}): write it as "<provider>:<group>", for instance "${providerIds[0] ?? 'idp'}:${raw}"`
  );
}

/** The names a local group may not take: the rule's group, with and without its provider. */
export function reservedGroupNames(raw: string | null): string[] {
  if (raw === null) return [];
  const split = splitAdminGroup(raw);
  return split ? [raw, split.name] : [raw];
}

/* ------------------------------------------------------------------------ */
/* The providers the configuration sets                                      */
/* ------------------------------------------------------------------------ */

/** The single-provider settings (`idp.*`, or the ones saved before several providers) as provider `idp`. */
export function legacyProviderOf(idp: {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly claims: IdpClaimMapping;
  readonly allowedEmailDomains: readonly string[];
  readonly invitationOnly: boolean;
}): OidcSignInProvider {
  return {
    kind: 'oidc',
    id: LEGACY_PROVIDER_ID,
    name: idp.issuer.hostname,
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    claims: idp.claims,
    allowedEmailDomains: idp.allowedEmailDomains,
    invitationOnly: idp.invitationOnly,
  };
}

/** Every provider the mounted configuration and the environment set: `idp.*` first, then `sign_in.*`. */
export function fileSignInProviders(config: {
  readonly idp: Parameters<typeof legacyProviderOf>[0] | null;
  readonly signIn: readonly SignInProvider[];
}): SignInProvider[] {
  return [...(config.idp ? [legacyProviderOf(config.idp)] : []), ...config.signIn];
}
