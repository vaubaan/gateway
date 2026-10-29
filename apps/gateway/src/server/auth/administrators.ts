/**
 * Who administers the instance (spec §0 "Administrator", §4.2 Users, §4.3; ADR
 * administrators-live-in-the-instance). The store keeps the designations (migration
 * 0020): users, pending addresses, groups of a sign-in provider. A person
 * administers when they are an active user with a `user` designation, or a member —
 * as its own provider claims — of a `group` designation's group. Evaluated on every
 * check from the current rows, never from a session.
 *
 * The configuration's admin rule (`admin.emails`, `admin.group`) is a seed: applied
 * once, by the boot, while the store names nobody (`seedFromConfiguration`). A rule
 * changed afterwards is shown (`configurationDrift`) and applied only by an
 * administrator (`applyConfiguration`): the configuration grants nothing silently.
 *
 * No self-lockout: an act that would leave no administrator with a way in, when
 * there was one, is refused (`AdministratorsError('last-way-in')`).
 */
import {
  CONFIGURATION_ACTOR_ID,
  type AdminAuditEntry,
  type AuditWriter,
} from '@vaubaan/gateway-core';

import {
  issuerKey,
  LEGACY_PROVIDER_ID,
  resolveAdminGroup,
  type AdminGroup,
} from '../config/sign-in';
import type { AdminRule } from '../config/types';
import { parseRestoredAdminRule, RESTORED_ADMIN_RULE_KEY } from './restored-admin-rule';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, toIso, type Clock } from '../store/clock';
import type {
  AdministratorOrigin,
  Designation,
  EmailDesignation,
  GroupDesignation,
  UserDesignation,
} from '../store/repositories/administrators';
import type { GroupRecord, UserRecord } from '../store/types';

/** The audit object of every designation. */
export const ADMINISTRATORS_OBJECT_ID = 'administrators';
/** `instance_config`: the rule the boot applied, canonical JSON. */
export const SEEDED_RULE_KEY = 'administrators.seeded_rule';

/** The designations against the providers configured now. */
export interface ResolvedAdministrators {
  readonly designations: readonly Designation[];
  /** Users with a `user` designation. */
  readonly userIds: ReadonlySet<string>;
  /** Pending addresses: `provider` null for any provider. */
  readonly emails: readonly { readonly email: string; readonly provider: string | null }[];
  /** The groups of `group` designations that resolve to a configured provider. */
  readonly groups: readonly AdminGroup[];
}

/** What `isOperator` reads of a user. */
export interface AdministratorSubject {
  readonly id: string;
  /** For a pending address not consumed yet (the person has not signed in since it was named). */
  readonly email: string;
  /** The provider the user signs in through, when known: a pending address may name one. */
  readonly providerId?: string | null;
  /** The user's groups now; only the IdP-sourced ones of a designated group's provider count. */
  readonly groups: readonly Pick<GroupRecord, 'name' | 'source' | 'provider'>[];
}

/** Whether a group designation resolves, against these provider ids, and to what. */
export function resolveGroupDesignation(
  designation: Pick<GroupDesignation, 'groupName' | 'provider'>,
  providerIds: readonly string[],
): AdminGroup | null {
  if (designation.provider === null) {
    // A bare `admin.group` carried over from the configuration: resolved as it always
    // was (the one provider; `<provider>:<group>` for a configured provider).
    return resolveAdminGroup(
      designation.groupName,
      providerIds.length > 0 ? providerIds : [LEGACY_PROVIDER_ID],
    );
  }
  return providerIds.includes(designation.provider)
    ? { provider: designation.provider, name: designation.groupName }
    : null;
}

export function resolveAdministrators(
  designations: readonly Designation[],
  providerIds: readonly string[],
): ResolvedAdministrators {
  const userIds = new Set<string>();
  const emails: { email: string; provider: string | null }[] = [];
  const groups: AdminGroup[] = [];
  for (const d of designations) {
    if (d.kind === 'user') userIds.add(d.userId);
    else if (d.kind === 'email') emails.push({ email: d.email, provider: d.provider });
    else {
      const group = resolveGroupDesignation(d, providerIds);
      if (group) groups.push(group);
    }
  }
  return { designations, userIds, emails, groups };
}

/**
 * Whether the subject administers: a `user` designation, a designated group its provider
 * claims, or a pending address that names it and that its next sign-in will consume.
 */
export function isOperator(
  subject: AdministratorSubject,
  administrators: ResolvedAdministrators,
): boolean {
  if (administrators.userIds.has(subject.id)) return true;
  const email = subject.email.toLowerCase();
  if (
    administrators.emails.some(
      (e) =>
        e.email === email &&
        (e.provider === null || (subject.providerId != null && e.provider === subject.providerId)),
    )
  ) {
    return true;
  }
  return subject.groups.some(
    (g) =>
      g.source === 'idp' &&
      administrators.groups.some((a) => a.provider === g.provider && a.name === g.name),
  );
}

/** The designated groups a provider claims: what a GitHub sign-in reads the teams of. */
export function groupsOfProvider(
  administrators: ResolvedAdministrators,
  providerId: string,
): AdminGroup[] {
  return administrators.groups.filter((g) => g.provider === providerId);
}

/** Whether a pending address names this email for this provider. */
export function pendingEmailNames(
  administrators: ResolvedAdministrators,
  email: string,
  providerId: string,
): boolean {
  const lower = email.toLowerCase();
  return administrators.emails.some(
    (e) => e.email === lower && (e.provider === null || e.provider === providerId),
  );
}

/** The designation as an audit entry and a page show it: never a secret. */
export function designationView(d: Designation): Record<string, unknown> {
  const base = { id: d.id, kind: d.kind, origin: d.origin, granted_by: d.grantedBy };
  if (d.kind === 'user') return { ...base, user_id: d.userId };
  if (d.kind === 'email') return { ...base, email: d.email, provider: d.provider };
  return { ...base, group: d.groupName, provider: d.provider };
}

export const ADMINISTRATORS_ERROR_CODES = [
  'last-way-in',
  'not-found',
  'not-a-user',
  'group-invalid',
  'already',
] as const;
export type AdministratorsErrorCode = (typeof ADMINISTRATORS_ERROR_CODES)[number];

export const ADMINISTRATORS_ERROR_MESSAGES: Readonly<Record<AdministratorsErrorCode, string>> = {
  'last-way-in':
    'Refused: no administrator would have a way in left. Make another person administrator, or give them another way in, first.',
  'not-found': 'This administrator designation does not exist any more.',
  'not-a-user': 'This person is not a user of this gateway.',
  'group-invalid':
    'Name a group of a sign-in provider configured on this gateway (for GitHub, a team: org/team).',
  already: 'This is already an administrator.',
};

export class AdministratorsError extends Error {
  readonly code: AdministratorsErrorCode;
  constructor(code: AdministratorsErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AdministratorsError';
    this.code = code;
  }
}

/** What an act would take away, for the no-lockout check. */
export interface LockoutChange {
  readonly withoutDesignation?: string;
  readonly withoutUser?: string;
  readonly withoutProvider?: string;
  /** Every active administrator, whether or not a provider lets them in now. */
  readonly anyWay?: boolean;
}

/** A provider as the way-in check reads it. */
export interface WayInProvider {
  readonly id: string;
  readonly kind: string;
  readonly issuer: URL;
  /** A provider switched off is no way in (ADR, §5). */
  readonly enabled?: boolean;
}

export interface AdministratorsDeps {
  readonly store: Pick<
    Store,
    'administrators' | 'users' | 'groups' | 'config' | 'localAccounts' | 'auditWriter'
  >;
  /** The providers configured now (`SignInProvidersService.views`). */
  readonly providers: () => Promise<readonly WayInProvider[]>;
  /** The configuration's rule: the seed. */
  readonly rule: AdminRule;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly clock?: Clock;
}

/** What the configuration's rule says and what was applied, when they differ. */
export interface ConfigurationDrift {
  readonly configured: AdminRule;
  readonly applied: AdminRule | null;
}

function canonicalRule(rule: AdminRule): string {
  return JSON.stringify({ emails: [...rule.emails].sort(), group: rule.group });
}

function parseRule(raw: string | null): AdminRule | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { emails?: unknown; group?: unknown };
    const emails = Array.isArray(value.emails)
      ? value.emails.filter((e): e is string => typeof e === 'string')
      : [];
    const group = typeof value.group === 'string' ? value.group : null;
    return { emails, group };
  } catch {
    return null;
  }
}

function isEmptyRule(rule: AdminRule): boolean {
  return rule.group === null && rule.emails.length === 0;
}

export class AdministratorsService {
  private readonly clock: Clock;

  constructor(private readonly deps: AdministratorsDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The designations against the providers configured now. */
  async current(): Promise<ResolvedAdministrators> {
    const [designations, providers] = await Promise.all([
      this.deps.store.administrators.list(),
      this.deps.providers(),
    ]);
    return resolveAdministrators(
      designations,
      providers.map((p) => p.id),
    );
  }

  /** Whether the store names anybody (any designation, pending ones included). */
  async any(): Promise<boolean> {
    return (await this.deps.store.administrators.count()) > 0;
  }

  async isAdministrator(user: UserRecord): Promise<boolean> {
    if (user.status !== 'active') return false;
    const groups = await this.deps.store.groups.groupsOf(user.id);
    return isOperator(
      { id: user.id, email: user.email, providerId: await this.providerIdOf(user), groups },
      await this.current(),
    );
  }

  /** The id of the provider a user signs in through (by their issuer), or `null`. */
  async providerIdOf(user: Pick<UserRecord, 'issuer'>): Promise<string | null> {
    if (user.issuer === null) return null;
    const key = issuerKey(user.issuer);
    return (await this.deps.providers()).find((p) => issuerKey(p.issuer) === key)?.id ?? null;
  }

  /**
   * Whether an identity about to sign in administers, or will once signed in: a user
   * designation of its (issuer, subject), a pending address for its provider, or a
   * designated group its provider claims it a member of. What admission reads.
   */
  async admits(
    identity: {
      readonly issuer: string;
      readonly subject: string;
      readonly email: string;
      readonly groups: readonly string[];
    },
    providerId: string,
  ): Promise<boolean> {
    const administrators = await this.current();
    if (pendingEmailNames(administrators, identity.email, providerId)) return true;
    if (
      groupsOfProvider(administrators, providerId).some((g) => identity.groups.includes(g.name))
    ) {
      return true;
    }
    const known = await this.deps.store.users.getByIdentity(identity.issuer, identity.subject);
    return known !== null && administrators.userIds.has(known.id);
  }

  /**
   * At a sign-in, after the user's row: the pending addresses that name them become
   * their `user` designation. Audited in the name of who named the address.
   */
  async consumeAtSignIn(user: UserRecord, providerId: string): Promise<boolean> {
    const consumed = await this.deps.store.administrators.consumeEmail(
      user.id,
      user.email,
      providerId,
    );
    const first = consumed[0];
    if (!first) return false;
    await this.write(first.grantedBy, 'administrator-granted', null, {
      kind: 'user',
      user_id: user.id,
      email: user.email,
      provider: providerId,
      origin: first.origin,
      from: consumed.map((d) => designationView(d)),
    });
    this.deps.logger.info('a pending administrator address signed in: now an administrator', {
      user_id: user.id,
      provider: providerId,
    });
    return true;
  }

  /** Makes a user administrator. `null` when they already were (nothing written). */
  async grantUser(
    userId: string,
    actor: string,
    origin: AdministratorOrigin = 'granted',
  ): Promise<UserDesignation | null> {
    const user = await this.deps.store.users.getById(userId);
    if (!user || user.status !== 'active') throw new AdministratorsError('not-a-user', userId);
    const row = await this.deps.store.administrators.addUser(userId, { grantedBy: actor, origin });
    if (!row) return null;
    await this.write(actor, 'administrator-granted', null, {
      ...designationView(row),
      email: user.email,
    });
    return row;
  }

  /** Names an address, for one provider or any, administrator at its first sign-in. */
  async grantEmail(
    email: string,
    provider: string | null,
    actor: string,
    origin: AdministratorOrigin = 'granted',
  ): Promise<EmailDesignation | null> {
    const row = await this.deps.store.administrators.addEmail(email, provider, {
      grantedBy: actor,
      origin,
    });
    if (!row) return null;
    await this.write(actor, 'administrator-granted', null, designationView(row));
    return row;
  }

  /** Names a group of a configured provider. */
  async grantGroup(
    provider: string,
    groupName: string,
    actor: string,
    origin: AdministratorOrigin = 'granted',
  ): Promise<GroupDesignation | null> {
    const name = groupName.trim();
    const providers = await this.deps.providers();
    const target = providers.find((p) => p.id === provider);
    if (!target || target.kind === 'local' || name.length === 0) {
      throw new AdministratorsError('group-invalid', `${provider}:${name}`);
    }
    const row = await this.deps.store.administrators.addGroup(name, provider, {
      grantedBy: actor,
      origin,
    });
    if (!row) return null;
    await this.write(actor, 'administrator-granted', null, designationView(row));
    return row;
  }

  /** Removes a designation, unless it would leave no administrator with a way in. */
  async revoke(designationId: string, actor: string): Promise<Designation> {
    const designation = await this.deps.store.administrators.get(designationId);
    if (!designation) throw new AdministratorsError('not-found', designationId);
    await this.assertNoLockout({ withoutDesignation: designationId });
    const removed = await this.deps.store.administrators.remove(designationId);
    if (!removed) throw new AdministratorsError('not-found', designationId);
    await this.write(actor, 'administrator-revoked', designationView(removed), null);
    return removed;
  }

  /** The `user` designation of a user, to unmake them. */
  async designationOfUser(userId: string): Promise<UserDesignation | null> {
    return this.deps.store.administrators.ofUser(userId);
  }

  /**
   * The administrators who have a way in: active users, administrators by a `user`
   * designation or a designated group's membership, whose provider (found by their
   * issuer) is configured and enabled — and, for local accounts, whose account exists.
   */
  async withAWayIn(change: LockoutChange = {}): Promise<UserRecord[]> {
    const providers = (await this.deps.providers()).filter(
      (p) => p.enabled !== false && p.id !== change.withoutProvider,
    );
    const designations = (await this.deps.store.administrators.list()).filter(
      (d) => d.id !== change.withoutDesignation,
    );
    const administrators = resolveAdministrators(
      designations,
      (await this.deps.providers()).map((p) => p.id),
    );
    const candidates = new Map<string, UserRecord>();
    for (const userId of administrators.userIds) {
      const user = await this.deps.store.users.getById(userId);
      if (user) candidates.set(user.id, user);
    }
    for (const pending of administrators.emails) {
      for (const user of await this.deps.store.users.findByEmail(pending.email)) {
        if (pending.provider === null || (await this.providerIdOf(user)) === pending.provider) {
          candidates.set(user.id, user);
        }
      }
    }
    for (const group of administrators.groups) {
      const record = await this.deps.store.groups.getByName(group.name);
      if (!record || record.source !== 'idp' || record.provider !== group.provider) continue;
      for (const member of await this.deps.store.groups.listMembers(record.id)) {
        candidates.set(member.id, member);
      }
    }
    if (change.anyWay === true) {
      return [...candidates.values()].filter(
        (user) => user.status === 'active' && user.id !== change.withoutUser,
      );
    }
    const out: UserRecord[] = [];
    for (const user of candidates.values()) {
      if (user.status !== 'active' || user.id === change.withoutUser) continue;
      if (user.issuer === null) continue;
      const provider = providers.find((p) => issuerKey(p.issuer) === issuerKey(user.issuer ?? ''));
      if (!provider) continue;
      if (provider.kind === 'local') {
        const account = await this.deps.store.localAccounts.getById(user.subject);
        if (!account) continue;
      }
      out.push(user);
    }
    return out;
  }

  /**
   * Refuses a change after which no administrator would have a way in, when one has
   * now. An instance whose setup names nobody yet has nothing to protect.
   */
  async assertNoLockout(change: LockoutChange): Promise<void> {
    if ((await this.withAWayIn()).length === 0) return;
    if ((await this.withAWayIn(change)).length > 0) return;
    throw new AdministratorsError('last-way-in', JSON.stringify(change));
  }

  /**
   * Applies the configuration's rule while the store names nobody: every address
   * becomes a pending designation for any provider, and every active user already
   * known by it a `user` designation; the group a `group` designation as written.
   * Recorded (`administrators.seeded_rule`) and audited once. Returns whether it applied.
   */
  async seedFromConfiguration(): Promise<boolean> {
    // A copy made by a backup that carries the sign-in configuration (docs/handbook/authentication.md) and
    // this one carries its source's rule: read once, with the configuration's.
    const carried = parseRestoredAdminRule(
      await this.deps.store.config.get(RESTORED_ADMIN_RULE_KEY),
    );
    if (await this.any()) {
      if (carried) await this.deps.store.config.delete(RESTORED_ADMIN_RULE_KEY);
      this.reportDrift(await this.configurationDrift());
      return false;
    }
    const configured = this.deps.rule;
    const emails = [...configured.emails];
    for (const email of carried?.emails ?? []) if (!emails.includes(email)) emails.push(email);
    const groupsWritten = [configured.group, carried?.group ?? null].filter(
      (g, i, all): g is string => g !== null && all.indexOf(g) === i,
    );
    if (emails.length === 0 && groupsWritten.length === 0) {
      if (carried) await this.deps.store.config.delete(RESTORED_ADMIN_RULE_KEY);
      return false;
    }
    const users: string[] = [];
    const pending: { email: string; provider: string | null }[] = [];
    for (const email of emails) {
      const known = (await this.deps.store.users.findByEmail(email)).filter(
        (u) => u.status === 'active',
      );
      users.push(...known.map((u) => u.id));
      // Still pending for the provider nobody signed in through yet: as before the
      // upgrade, the address is an administrator through any provider until its
      // first sign-in consumes it.
      if (known.length === 0) pending.push({ email, provider: null });
    }
    const groups = groupsWritten.map((groupName) => ({ groupName, provider: null }));
    const written = await this.deps.store.administrators.addMany(users, pending, groups, {
      grantedBy: CONFIGURATION_ACTOR_ID,
      origin: 'configuration',
    });
    // The configuration's own rule is what a later boot compares against.
    await this.deps.store.config.set(SEEDED_RULE_KEY, canonicalRule(configured));
    if (carried) await this.deps.store.config.delete(RESTORED_ADMIN_RULE_KEY);
    await this.write(CONFIGURATION_ACTOR_ID, 'administrators-seeded', null, {
      rule: { emails: configured.emails, group: configured.group },
      ...(carried ? { carried_by_backup: { emails: carried.emails, group: carried.group } } : {}),
      designations: written.map((d) => designationView(d)),
    });
    this.deps.logger.info(
      'administrators named by the configuration, once: they live in the store now',
      {
        users: users.length,
        pending_addresses: pending.length,
        groups: groupsWritten.length,
        carried_by_backup: carried !== null,
      },
    );
    return true;
  }

  /** The configuration's rule when it differs from the one applied; `null` otherwise. */
  async configurationDrift(): Promise<ConfigurationDrift | null> {
    const rule = this.deps.rule;
    if (isEmptyRule(rule)) return null;
    const applied = parseRule(await this.deps.store.config.get(SEEDED_RULE_KEY));
    if (applied && canonicalRule(applied) === canonicalRule(rule)) return null;
    return { configured: rule, applied };
  }

  /**
   * An administrator applies the configuration's rule as it is now: each address and
   * the group become designations in their name. Recorded as the rule applied.
   */
  async applyConfiguration(actor: string): Promise<Designation[]> {
    const rule = this.deps.rule;
    const out: Designation[] = [];
    for (const email of rule.emails) {
      const known = (await this.deps.store.users.findByEmail(email)).filter(
        (u) => u.status === 'active',
      );
      if (known.length > 0) {
        for (const user of known) {
          const row = await this.grantUser(user.id, actor);
          if (row) out.push(row);
        }
      } else {
        const row = await this.grantEmail(email, null, actor);
        if (row) out.push(row);
      }
    }
    if (rule.group !== null) {
      const row = await this.deps.store.administrators.addGroup(rule.group, null, {
        grantedBy: actor,
        origin: 'granted',
      });
      if (row) {
        await this.write(actor, 'administrator-granted', null, designationView(row));
        out.push(row);
      }
    }
    await this.deps.store.config.set(SEEDED_RULE_KEY, canonicalRule(rule));
    return out;
  }

  private reportDrift(drift: ConfigurationDrift | null): void {
    if (!drift) return;
    this.deps.logger.warn(
      'the admin rule of the configuration differs from the one applied: not applied, administrators live in the instance (Administration → Users applies it)',
      {
        emails: drift.configured.emails.length,
        group: drift.configured.group !== null,
      },
    );
  }

  private async write(
    actor: string,
    act: AdminAuditEntry['act'],
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: toIso(this.clock.now()),
      user_id: actor,
      act,
      object: { type: 'instance-config', id: ADMINISTRATORS_OBJECT_ID },
      before,
      after,
      delegated_client_id: null,
    });
  }
}
