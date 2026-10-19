/**
 * Local accounts (spec §0 "Local account", §6; ADR
 * local-accounts-sign-in-provider): the accounts of a sign-in provider of kind
 * `local`, kept by the instance — an e-mail, an argon2id password hash, later a
 * second factor — and the single-use links through which an account is created
 * (an invitation) or its password set again (a reset).
 *
 * This service decides on accounts and links; who may call it is the handlers'
 * business (`local-handlers.ts` for the anonymous forms, the users module for
 * the administrator's acts). Admission at sign-in stays `admission.ts`'s.
 *
 * Lockout: `LOCAL_LOCKOUT` wrong passwords within its window lock the account
 * for `lockMs`, counted in the store (a restart resets nothing). An unknown
 * address, a wrong password and a locked account are one answer, and cost the
 * same time (`decoyHash`).
 *
 * Audited (`AdminAuditEntry`, object `instance-config` /
 * `local-account:<provider>`): `local-link-created`, `local-account-created`,
 * `local-password-changed`, `local-account-removed`. Never a secret, never a link.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { AuditWriter } from '@vaubaan/gateway-core';

import { decoyHash, hashPassword, passwordProblem, verifyPassword } from '../crypto/password';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { LocalAccountRecord, LocalLinkKind, LocalLinkRecord, LockoutRule } from '../store';
import { LocalAccountError } from './errors';

const MINUTE_MS = 60_000;

/** Ten wrong passwords in fifteen minutes lock the account for fifteen minutes. */
export const LOCAL_LOCKOUT: LockoutRule = {
  maxAttempts: 10,
  windowMs: 15 * MINUTE_MS,
  lockMs: 15 * MINUTE_MS,
};

/** A link creates an account or resets a password for fifteen minutes, once. */
export const LOCAL_LINK_TTL_MS = 15 * MINUTE_MS;

export const CREATE_ACCOUNT_PAGE = '/account/create';
export const RESET_PASSWORD_PAGE = '/account/reset';
export const FORGOT_PASSWORD_PAGE = '/account/forgot';
/** The query parameter a link carries its token in. */
export const LINK_TOKEN_PARAM = 'token';

/** RFC 5321's limit on a path, which bounds an address. */
const MAX_EMAIL_LENGTH = 254;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const EMAIL = /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/;

/** The address as stored: trimmed, lower-cased; `null` when it is not an address. */
export function normalizeLocalEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return null;
  return email;
}

export type PasswordCheck =
  | { readonly ok: true; readonly account: LocalAccountRecord }
  | { readonly ok: false; readonly cause: 'unknown' | 'wrong' | 'locked' };

export interface IssuedLink {
  /** The token, shown once: in the mail, or to the administrator to copy. */
  readonly token: string;
  readonly url: URL;
  readonly link: LocalLinkRecord;
}

export interface LocalAccountsDeps {
  readonly store: Pick<Store, 'localAccounts'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publicUrl: URL;
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The audit object id of a provider's accounts. */
export function localAccountsObjectId(providerId: string): string {
  return `local-account:${providerId}`;
}

export class LocalAccountsService {
  constructor(private readonly deps: LocalAccountsDeps) {}

  /** The address a link points at: the create-account page or the reset page, with the token. */
  linkUrl(kind: LocalLinkKind, token: string): URL {
    const url = new URL(
      kind === 'invite' ? CREATE_ACCOUNT_PAGE : RESET_PASSWORD_PAGE,
      this.deps.publicUrl,
    );
    url.searchParams.set(LINK_TOKEN_PARAM, token);
    return url;
  }

  /**
   * A new single-use link for the address; the unused ones of that kind are retired.
   * The token is returned once and never stored.
   */
  async createLink(input: {
    readonly kind: LocalLinkKind;
    readonly providerId: string;
    readonly email: string;
    readonly createdBy: string;
  }): Promise<IssuedLink> {
    const email = normalizeLocalEmail(input.email);
    if (!email) throw new LocalAccountError('address-invalid');
    if (input.kind === 'reset') {
      const account = await this.deps.store.localAccounts.getByEmail(input.providerId, email);
      if (!account) throw new LocalAccountError('account-not-found');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = toIso(new Date(this.deps.clock.now().getTime() + LOCAL_LINK_TTL_MS));
    const link = await this.deps.store.localAccounts.createLink({
      kind: input.kind,
      provider: input.providerId,
      email,
      tokenSha256: tokenDigest(token),
      createdBy: input.createdBy,
      expiresAt,
    });
    await this.audit(input.createdBy, 'local-link-created', input.providerId, null, {
      kind: input.kind,
      email,
      expires_at: expiresAt,
    });
    this.deps.logger.info('local account link created', {
      kind: input.kind,
      provider: input.providerId,
    });
    return { token, url: this.linkUrl(input.kind, token), link };
  }

  /** The link behind a token when it can still be used; `null` otherwise (one answer for every cause). */
  async inspectLink(token: string): Promise<LocalLinkRecord | null> {
    if (token.length === 0 || token.length > 128) return null;
    const link = await this.deps.store.localAccounts.getLinkByToken(tokenDigest(token));
    if (!link || link.usedAt !== null) return null;
    if (Date.parse(link.expiresAt) <= this.deps.clock.now().getTime()) return null;
    return link;
  }

  /** The person creates their account on an invitation link: the link is spent first. */
  async createAccountFromLink(token: string, password: string): Promise<LocalAccountRecord> {
    const link = await this.inspectLink(token);
    if (!link || link.kind !== 'invite') throw new LocalAccountError('link-invalid');
    const problem = passwordProblem(password);
    if (problem) throw new LocalAccountError('password-weak', problem);
    if (await this.deps.store.localAccounts.getByEmail(link.provider, link.email)) {
      throw new LocalAccountError('account-exists');
    }
    if (!(await this.deps.store.localAccounts.useLink(link.id))) {
      throw new LocalAccountError('link-invalid');
    }
    return this.create(link.provider, link.email, password, link.createdBy);
  }

  /** The setup or an administrator creates an account outright (the first administrator). */
  async createAccount(input: {
    readonly providerId: string;
    readonly email: string;
    readonly password: string;
    readonly actor: string;
  }): Promise<LocalAccountRecord> {
    const email = normalizeLocalEmail(input.email);
    if (!email) throw new LocalAccountError('address-invalid');
    const problem = passwordProblem(input.password);
    if (problem) throw new LocalAccountError('password-weak', problem);
    if (await this.deps.store.localAccounts.getByEmail(input.providerId, email)) {
      throw new LocalAccountError('account-exists');
    }
    return this.create(input.providerId, email, input.password, input.actor);
  }

  /** The person sets a new password on a reset link: the link is spent first. */
  async resetPasswordFromLink(token: string, password: string): Promise<LocalAccountRecord> {
    const link = await this.inspectLink(token);
    if (!link || link.kind !== 'reset') throw new LocalAccountError('link-invalid');
    const problem = passwordProblem(password);
    if (problem) throw new LocalAccountError('password-weak', problem);
    const account = await this.deps.store.localAccounts.getByEmail(link.provider, link.email);
    if (!account) throw new LocalAccountError('link-invalid');
    if (!(await this.deps.store.localAccounts.useLink(link.id))) {
      throw new LocalAccountError('link-invalid');
    }
    await this.setPassword(account, password, link.createdBy);
    return account;
  }

  /** A signed-in person changes their own password (the actor is their user id). */
  async changePassword(accountId: string, password: string, actor: string): Promise<void> {
    const account = await this.deps.store.localAccounts.getById(accountId);
    if (!account) throw new LocalAccountError('account-not-found');
    const problem = passwordProblem(password);
    if (problem) throw new LocalAccountError('password-weak', problem);
    await this.setPassword(account, password, actor);
  }

  /**
   * Whether `password` is the account's. One answer and one cost for an unknown
   * address, a wrong password and a locked account; a wrong password counts
   * towards the lockout, a right one clears the count.
   */
  async checkPassword(providerId: string, email: string, password: string): Promise<PasswordCheck> {
    const normalized = normalizeLocalEmail(email);
    const account = normalized
      ? await this.deps.store.localAccounts.getByEmail(providerId, normalized)
      : null;
    if (!account) {
      await verifyPassword(await decoyHash(), password);
      return { ok: false, cause: 'unknown' };
    }
    const now = this.deps.clock.now().getTime();
    if (account.lockedUntil !== null && Date.parse(account.lockedUntil) > now) {
      await verifyPassword(await decoyHash(), password);
      this.deps.logger.warn('local sign-in refused: account locked', { provider: providerId });
      return { ok: false, cause: 'locked' };
    }
    const hash = await this.deps.store.localAccounts.readSecret(account.id, 'password');
    const right = hash !== null && (await verifyPassword(hash, password));
    if (!right) {
      if (hash === null) await verifyPassword(await decoyHash(), password);
      const after = await this.deps.store.localAccounts.recordFailure(account.id, LOCAL_LOCKOUT);
      if (after?.lockedUntil && Date.parse(after.lockedUntil) > now) {
        this.deps.logger.warn('local account locked after too many wrong passwords', {
          provider: providerId,
          attempts: after.failedAttempts,
        });
      }
      return { ok: false, cause: 'wrong' };
    }
    if (account.failedAttempts > 0 || account.lockedUntil !== null) {
      await this.deps.store.localAccounts.clearFailures(account.id);
    }
    return { ok: true, account };
  }

  async accountOf(providerId: string, email: string): Promise<LocalAccountRecord | null> {
    const normalized = normalizeLocalEmail(email);
    return normalized ? this.deps.store.localAccounts.getByEmail(providerId, normalized) : null;
  }

  async accountById(id: string): Promise<LocalAccountRecord | null> {
    return this.deps.store.localAccounts.getById(id);
  }

  async list(providerId: string): Promise<LocalAccountRecord[]> {
    return this.deps.store.localAccounts.list(providerId);
  }

  /** The unused, unexpired links of an address, newest first. */
  async pendingLinks(providerId: string, email: string): Promise<LocalLinkRecord[]> {
    return this.deps.store.localAccounts.pendingLinks(providerId, email);
  }

  /** An administrator removes an account: the person can no longer sign in through it. */
  async remove(accountId: string, actor: string): Promise<LocalAccountRecord> {
    const account = await this.deps.store.localAccounts.getById(accountId);
    if (!account) throw new LocalAccountError('account-not-found');
    await this.deps.store.localAccounts.remove(accountId);
    await this.audit(
      actor,
      'local-account-removed',
      account.provider,
      { email: account.email },
      null,
    );
    this.deps.logger.info('local account removed', { provider: account.provider });
    return account;
  }

  private async create(
    providerId: string,
    email: string,
    password: string,
    actor: string,
  ): Promise<LocalAccountRecord> {
    const hash = await hashPassword(password);
    const account = await this.deps.store.localAccounts.create({ provider: providerId, email });
    if (!account) throw new LocalAccountError('account-exists');
    await this.deps.store.localAccounts.writeSecret(account.id, 'password', hash);
    await this.deps.store.localAccounts.markPasswordChanged(account.id);
    await this.audit(actor, 'local-account-created', providerId, null, { email });
    this.deps.logger.info('local account created', { provider: providerId });
    return account;
  }

  private async setPassword(
    account: LocalAccountRecord,
    password: string,
    actor: string,
  ): Promise<void> {
    const hash = await hashPassword(password);
    await this.deps.store.localAccounts.writeSecret(account.id, 'password', hash);
    await this.deps.store.localAccounts.markPasswordChanged(account.id);
    await this.deps.store.localAccounts.clearFailures(account.id);
    await this.audit(actor, 'local-password-changed', account.provider, null, {
      email: account.email,
    });
    this.deps.logger.info('local account password changed', { provider: account.provider });
  }

  private async audit(
    actor: string,
    act:
      | 'local-link-created'
      | 'local-account-created'
      | 'local-password-changed'
      | 'local-account-removed',
    providerId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    try {
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: actor,
        act,
        object: { type: 'instance-config', id: localAccountsObjectId(providerId) },
        before,
        after,
        delegated_client_id: null,
      });
    } catch (err) {
      this.deps.logger.error('local accounts: audit write failed', { act, err });
    }
  }
}
