/**
 * The one-shot move of the single-provider settings of earlier builds into the
 * sign-in providers (gateway audit 2026-10-31, F7; ADR
 * users-keyed-by-issuer-and-subject, amendment 2026-10-31).
 *
 * Before several sign-in providers existed, an instance kept its identity provider
 * under the `instance_config` keys `idp.*` (the secret sealed under
 * `instance_config:idp.client_secret`), and the code special-cased the provider id
 * `idp` everywhere: its callback, its audit object, its admin groups, its settings
 * form. At boot, before the authentication module reads anything, those keys
 * become an ordinary saved provider with the id `idp` — `sign_in.idp` and its
 * secret, re-sealed under its own key, in one transaction that also deletes them —
 * and its users, its groups (`groups.provider = 'idp'`), its administrators and its
 * second-factor waiver (`sign_in_state.idp`) keep the id they already carry. Its
 * callback becomes `<public_url>/auth/callback/idp`: the operator registers it at
 * the identity provider (CHANGELOG upgrade note).
 *
 * Accounts created before the store recorded an issuer (migration 0011, before
 * 2.0.0-alpha.1) were bound at their provider's first sign-in through `idp`; that
 * special case is gone with the rest, and the configured issuer is not what the
 * provider signs (ADR users-keyed-by-issuer-and-subject), so they are not bound here
 * either: the boot names how many are left, and such a person signs in as somebody
 * new. The move is a no-op once done, and runs at every boot so a restored older
 * backup is moved too.
 */
import { DEFAULT_CLAIM_MAPPING, type OidcSignInProvider } from '../config/sign-in';
import type { Logger } from '../logging';
import type { Store } from '../store';
import type { ConfigWrite } from '../store/repositories/config';
import { storedProviderWrites } from './sign-in-providers';

/** The id the single provider of earlier builds was known by, kept by its users and groups. */
export const SINGLE_PROVIDER_ID = 'idp';

/** The keys earlier builds kept the single provider under. */
export const SINGLE_PROVIDER_KEYS = {
  issuer: 'idp.issuer',
  clientId: 'idp.client_id',
  clientSecret: 'idp.client_secret',
  claimSub: 'idp.claims.sub',
  claimEmail: 'idp.claims.email',
  claimGroups: 'idp.claims.groups',
  allowedEmailDomains: 'idp.allowed_email_domains',
  invitationOnly: 'idp.invitation_only',
} as const;

export interface SingleProviderUpgrade {
  /** Whether stored `idp.*` settings were moved to `sign_in.idp`. */
  readonly moved: boolean;
  /** Accounts of a build before 2.0.0-alpha.1 still bound to no issuer. */
  readonly unbound: number;
}

function domainsOf(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** The stored single provider as an ordinary OpenID Connect provider, or `null` when there is none. */
async function storedSingleProvider(config: Store['config']): Promise<OidcSignInProvider | null> {
  const keys = SINGLE_PROVIDER_KEYS;
  const [issuerRaw, clientId, clientSecret] = await Promise.all([
    config.get(keys.issuer),
    config.get(keys.clientId),
    config.getSecret(keys.clientSecret),
  ]);
  if (!issuerRaw || !clientId || !clientSecret) return null;
  let issuer: URL;
  try {
    issuer = new URL(issuerRaw);
  } catch {
    return null;
  }
  const [sub, email, groups, domains, invitationOnly] = await Promise.all([
    config.get(keys.claimSub),
    config.get(keys.claimEmail),
    config.get(keys.claimGroups),
    config.get(keys.allowedEmailDomains),
    config.get(keys.invitationOnly),
  ]);
  return {
    kind: 'oidc',
    id: SINGLE_PROVIDER_ID,
    name: issuer.hostname,
    issuer,
    clientId,
    clientSecret,
    claims: {
      sub: sub ?? DEFAULT_CLAIM_MAPPING.sub,
      email: email ?? DEFAULT_CLAIM_MAPPING.email,
      groups: groups ?? DEFAULT_CLAIM_MAPPING.groups,
    },
    allowedEmailDomains: domainsOf(domains),
    invitationOnly: invitationOnly === 'true',
  };
}

export async function upgradeSingleProviderSettings(deps: {
  readonly store: Pick<Store, 'config' | 'users'>;
  /** The providers the configuration sets (`sign_in.<id>.*`). */
  readonly configured: readonly { readonly id: string }[];
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly now: () => Date;
}): Promise<SingleProviderUpgrade> {
  const { store, logger } = deps;
  const stored = await storedSingleProvider(store.config);
  const leftovers = (await store.config.keys()).filter((key) =>
    (Object.values(SINGLE_PROVIDER_KEYS) as string[]).includes(key),
  );
  let moved = false;
  if (leftovers.length > 0) {
    const writes: ConfigWrite[] = [];
    const configuredHere = deps.configured.some((p) => p.id === SINGLE_PROVIDER_ID);
    const savedAlready = (await store.config.get(`sign_in.${SINGLE_PROVIDER_ID}`)) !== null;
    // The configuration's `sign_in.idp`, or one saved since, wins: the old keys only go.
    if (stored && !configuredHere && !savedAlready) {
      writes.push(...storedProviderWrites(stored, deps.now().toISOString()));
      moved = true;
    }
    writes.push(...leftovers.map((key): ConfigWrite => ({ kind: 'delete', key })));
    await store.config.apply(writes);
    logger.info('single-provider settings moved to the sign-in provider idp', {
      moved,
      removed_keys: leftovers.length,
      callback: `/auth/callback/${SINGLE_PROVIDER_ID}`,
      remedy: 'register <public_url>/auth/callback/idp at the identity provider',
    });
  }

  const unbound = (await store.users.list()).filter((user) => user.issuer === null).length;
  if (unbound > 0) {
    logger.warn('accounts of a build before 2.0.0-alpha.1 are bound to no issuer', {
      accounts: unbound,
      consequence:
        'each such person signs in as somebody new; an owner transfers what the old account held',
    });
  }
  return { moved, unbound };
}
