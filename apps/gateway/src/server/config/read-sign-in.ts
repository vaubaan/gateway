/**
 * Who signs in and who administers: `sign_in.<id>.*`, the retired single-provider
 * keys, the rules across providers, `admin.*` and `bootstrap_token`.
 */
import { type Reader, typeName } from './reader';
import { RETIRED_IDP_ENV_PREFIX, RETIRED_IDP_KEY } from './retired-keys';
import type { EnvSource } from './secret-refs';
import { SIGN_IN_ENV_PREFIX } from './named-blocks';
import {
  admissionProblem,
  adminGroupProblem,
  GITHUB_DOT_COM,
  GITHUB_IS_NOT_OIDC,
  isGithubDotComHost,
  DEFAULT_LOCAL_SIGN_IN_PROVIDER_NAME,
  isSignInKind,
  isSignInProviderId,
  localSignInProviderOf,
  issuerKey,
  normalizeEmailDomains,
  SIGN_IN_KINDS,
  type SignInProvider,
} from './sign-in';
import { envNamesFor, isKeyRequired, keySpec } from './sources';
import { isPlainObject, type RawTree } from './tree';
import type { AdminRule } from './types';

const MIN_BOOTSTRAP_TOKEN_LENGTH = keySpec('bootstrap_token').minLength;

/**
 * Required while the configuration sets no sign-in provider, but in local mode; long enough
 * to resist guessing.
 */
export function readBootstrapToken(
  r: Reader,
  hasSignInProvider: boolean,
  local: boolean,
): string | null {
  // Local mode makes one at each start when none is set (compose/boot-config.ts).
  const required = !local && isKeyRequired(keySpec('bootstrap_token'), hasSignInProvider);
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

/**
 * The single-provider keys of earlier builds (`idp.*`, `VAUBAAN_IDP_*`) are refused:
 * ignored, they would leave the instance without the provider people sign in with.
 * The same provider is `sign_in.idp.*`, whose callback is `<public_url>/auth/callback/idp`
 * (gateway audit 2026-10-31, F7; CHANGELOG upgrade note).
 */
export function refuseSingleSignInProviderKeys(r: Reader, raw: RawTree, env: EnvSource): void {
  const variables = Object.keys(env)
    .filter((name) => name.startsWith(RETIRED_IDP_ENV_PREFIX) && env[name] !== undefined)
    .sort();
  if (raw[RETIRED_IDP_KEY] === undefined && variables.length === 0) return;
  r.issues.add(
    RETIRED_IDP_KEY,
    'the single-provider keys are retired: write the same sign-in provider as sign_in.idp.* (kind oidc, issuer, client_id, client_secret, claims, allowed_email_domains, invitation_only; VAUBAAN_SIGN_IN_IDP_KIND=oidc, VAUBAAN_SIGN_IN_IDP_ISSUER, …) and register <public_url>/auth/callback/idp at the identity provider',
    variables,
  );
}

/**
 * `sign_in.<id>.*`: one provider per id, in the order of the tree (the file's keys,
 * then the environment's). Every problem is named by its key.
 */
export function readSignIn(r: Reader): SignInProvider[] {
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
    const signInProvider = readSignInProvider(r, id, base);
    if (signInProvider) out.push(signInProvider);
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
  if (kind === 'local') {
    // Sign-in accounts: an id and a name. Nothing to register anywhere, nothing to admit by.
    for (const field of [
      'issuer',
      'client_id',
      'client_secret',
      'claims',
      'allowed_email_domains',
      'invitation_only',
      'require_verified_email',
    ]) {
      if (r.has(`${base}.${field}`)) {
        r.issues.add(
          `${base}.${field}`,
          `a local sign-in provider keeps the accounts itself: it has no ${field.replace(/_/g, ' ')} (it admits invited addresses and the admin rule's only)`,
          envNamesFor(`${base}.${field}`),
        );
      }
    }
    const name =
      r.string(`${base}.name`, { fallback: DEFAULT_LOCAL_SIGN_IN_PROVIDER_NAME }) ??
      DEFAULT_LOCAL_SIGN_IN_PROVIDER_NAME;
    if (r.issues.items.length > before) return null;
    return localSignInProviderOf(id, name);
  }
  const clientId = r.string(`${base}.client_id`, { required: true });
  const clientSecret = r.string(`${base}.client_secret`, { required: true });
  const allowedEmailDomains = normalizeDomainsAt(r, `${base}.allowed_email_domains`);
  const invitationOnly = r.bool({ path: `${base}.invitation_only`, default: false });
  if (kind === 'github') {
    if (r.has(`${base}.require_verified_email`)) {
      r.issues.add(
        `${base}.require_verified_email`,
        'GitHub sign-in admits the primary verified address only: the option does not apply',
        envNamesFor(`${base}.require_verified_email`),
      );
    }
    if (r.has(`${base}.claims`)) {
      r.issues.add(
        `${base}.claims`,
        'GitHub sign-in has no claim mapping: the subject is the numeric user id and the email the primary verified address',
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
  // A static check: the configuration never reaches the network at boot.
  if (issuer && isGithubDotComHost(issuer)) {
    r.issues.add(`${base}.issuer`, GITHUB_IS_NOT_OIDC, envNamesFor(`${base}.issuer`));
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
 * The rules across the providers the configuration sets: one issuer each (a user is (issuer, subject): two providers
 * of one issuer would be one population with two admission rules), and an
 * admission rule for every open provider.
 */
export function checkSignInProviders(
  r: Reader,
  signIn: readonly SignInProvider[],
): SignInProvider[] {
  const all = [...signIn];
  const issuers = new Map<string, string>();
  const locals = all.filter((p) => p.kind === 'local');
  if (locals.length > 1) {
    r.issues.add(
      `sign_in.${locals[1]?.id ?? ''}.kind`,
      `sign-in providers '${locals.map((p) => p.id).join("', '")}' are all sign-in accounts: one local sign-in provider per instance`,
    );
  }
  for (const signInProvider of all) {
    const path = `sign_in.${signInProvider.id}`;
    const key = issuerKey(signInProvider.issuer);
    const other = issuers.get(key);
    if (other !== undefined && other !== signInProvider.id) {
      r.issues.add(
        `${path}.issuer`,
        `sign-in providers '${other}' and '${signInProvider.id}' have the same issuer ${key}: a user is (issuer, subject), so they would be one population with two admission rules`,
        envNamesFor(`${path}.issuer`),
      );
    }
    issuers.set(key, signInProvider.id);
    const problem = admissionProblem(signInProvider);
    if (problem) {
      r.issues.add(`${path}.allowed_email_domains`, problem, [
        ...envNamesFor(`${path}.allowed_email_domains`),
        ...envNamesFor(`${path}.invitation_only`),
      ]);
    }
  }
  return all;
}

export function readAdmin(r: Reader, signInProviders: readonly SignInProvider[]): AdminRule {
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
  // Optional: a seed the boot applies while the store names no administrator (ADR
  // administrators-live-in-the-instance). Without one the setup names the first.
  return { group, emails };
}
