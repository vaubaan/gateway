/**
 * Sign-in accounts (spec §0 "Sign-in account", §6; ADR
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
 * address, a wrong password and a locked account are one answer. An unknown
 * address and a wrong password cost the same time (`decoyHash`); a locked account
 * answers before any hash (security audit 2026-10-31, M2), so that a locked
 * account is no free hash for anonymous posts (threat model A44).
 *
 * Audited (`AdminAuditEntry`, object `instance-config` /
 * `sign-in-account:<sign-in provider>`): `local-link-created`, `sign-in-account-created`,
 * `local-password-changed`, `sign-in-account-removed`. Never a secret, never a link.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { AuditWriter } from '@vaubaan/gateway-core';

import { argon2Passwords, passwordProblem, type PasswordHasher } from '../crypto/password';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { SignInAccountRecord, LocalLinkKind, LocalLinkRecord, LockoutRule } from '../store';
import { SignInAccountError } from './errors';

const MINUTE_MS = 60_000;

/** Ten wrong passwords in fifteen minutes lock the account for fifteen minutes. */
export const LOCAL_LOCKOUT: LockoutRule = {
  maxAttempts: 10,
  windowMs: 15 * MINUTE_MS,
  lockMs: 15 * MINUTE_MS,
};

/** A link creates an account or resets a password for fifteen minutes, once. */
export const LOCAL_LINK_TTL_MS = 15 * MINUTE_MS;

export const CREATE_ACCOUNT_PAGE = '/sign-in-account/create';
export const RESET_PASSWORD_PAGE = '/sign-in-account/reset';
export const FORGOT_PASSWORD_PAGE = '/sign-in-account/forgot';
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
  | { readonly ok: true; readonly signInAccount: SignInAccountRecord }
  | { readonly ok: false; readonly cause: 'unknown' | 'wrong' | 'locked' };

export interface IssuedLink {
  /** The token, shown once: in the mail, or to the administrator to copy. */
  readonly token: string;
  readonly url: URL;
  readonly link: LocalLinkRecord;
}

export interface SignInAccountsDeps {
  readonly store: Pick<Store, 'signInAccounts'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publicUrl: URL;
  /** The password hashing; the native argon2id binding unless a test hands another. */
  readonly passwords?: PasswordHasher;
}

/** What an enrolment shows: the secret for the QR code and for typing by hand. */
function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The audit object id of a sign-in provider's accounts. */
export function signInAccountsObjectId(signInProviderId: string): string {
  return `sign-in-account:${signInProviderId}`;
}

export class SignInAccountsService {
  private readonly passwords: PasswordHasher;

  constructor(private readonly deps: SignInAccountsDeps) {
    this.passwords = deps.passwords ?? argon2Passwords;
  }

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
    readonly signInProviderId: string;
    readonly email: string;
    readonly createdBy: string;
  }): Promise<IssuedLink> {
    const email = normalizeLocalEmail(input.email);
    if (!email) throw new SignInAccountError('address-invalid');
    if (input.kind === 'reset') {
      const signInAccount = await this.deps.store.signInAccounts.getByEmail(
        input.signInProviderId,
        email,
      );
      if (!signInAccount) throw new SignInAccountError('sign-in-account-not-found');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = toIso(new Date(this.deps.clock.now().getTime() + LOCAL_LINK_TTL_MS));
    const link = await this.deps.store.signInAccounts.createLink({
      kind: input.kind,
      signInProvider: input.signInProviderId,
      email,
      tokenSha256: tokenDigest(token),
      createdBy: input.createdBy,
      expiresAt,
    });
    await this.audit(input.createdBy, 'local-link-created', input.signInProviderId, null, {
      kind: input.kind,
      email,
      expires_at: expiresAt,
    });
    this.deps.logger.info('sign-in account link created', {
      kind: input.kind,
      sign_in_provider: input.signInProviderId,
    });
    return { token, url: this.linkUrl(input.kind, token), link };
  }

  /** The link behind a token when it can still be used; `null` otherwise (one answer for every cause). */
  async inspectLink(token: string): Promise<LocalLinkRecord | null> {
    if (token.length === 0 || token.length > 128) return null;
    const link = await this.deps.store.signInAccounts.getLinkByToken(tokenDigest(token));
    if (!link || link.usedAt !== null) return null;
    if (Date.parse(link.expiresAt) <= this.deps.clock.now().getTime()) return null;
    return link;
  }

  /** The person creates their account on an invitation link: the link is spent first. */
  async createSignInAccountFromLink(token: string, password: string): Promise<SignInAccountRecord> {
    const link = await this.inspectLink(token);
    if (!link || link.kind !== 'invite') throw new SignInAccountError('link-invalid');
    const problem = passwordProblem(password);
    if (problem) throw new SignInAccountError('password-weak', problem);
    if (await this.deps.store.signInAccounts.getByEmail(link.signInProvider, link.email)) {
      throw new SignInAccountError('sign-in-account-exists');
    }
    if (!(await this.deps.store.signInAccounts.useLink(link.id))) {
      throw new SignInAccountError('link-invalid');
    }
    return this.create(link.signInProvider, link.email, password, link.createdBy);
  }

  /** The setup or an administrator creates an account outright (the first administrator). */
  async createSignInAccount(input: {
    readonly signInProviderId: string;
    readonly email: string;
    readonly password: string;
    readonly actor: string;
  }): Promise<SignInAccountRecord> {
    const email = normalizeLocalEmail(input.email);
    if (!email) throw new SignInAccountError('address-invalid');
    const problem = passwordProblem(input.password);
    if (problem) throw new SignInAccountError('password-weak', problem);
    if (await this.deps.store.signInAccounts.getByEmail(input.signInProviderId, email)) {
      throw new SignInAccountError('sign-in-account-exists');
    }
    return this.create(input.signInProviderId, email, input.password, input.actor);
  }

  /** The person sets a new password on a reset link: the link is spent first. */
  async resetPasswordFromLink(token: string, password: string): Promise<SignInAccountRecord> {
    const link = await this.inspectLink(token);
    if (!link || link.kind !== 'reset') throw new SignInAccountError('link-invalid');
    const problem = passwordProblem(password);
    if (problem) throw new SignInAccountError('password-weak', problem);
    const signInAccount = await this.deps.store.signInAccounts.getByEmail(
      link.signInProvider,
      link.email,
    );
    if (!signInAccount) throw new SignInAccountError('link-invalid');
    if (!(await this.deps.store.signInAccounts.useLink(link.id))) {
      throw new SignInAccountError('link-invalid');
    }
    await this.setPassword(signInAccount, password, link.createdBy);
    return signInAccount;
  }

  /** A signed-in person changes their own password (the actor is their user id). */
  async changePassword(signInAccountId: string, password: string, actor: string): Promise<void> {
    const signInAccount = await this.deps.store.signInAccounts.getById(signInAccountId);
    if (!signInAccount) throw new SignInAccountError('sign-in-account-not-found');
    const problem = passwordProblem(password);
    if (problem) throw new SignInAccountError('password-weak', problem);
    await this.setPassword(signInAccount, password, actor);
  }

  /**
   * Whether `password` is the account's. One answer for an unknown address, a wrong
   * password and a locked account, one cost for the first two; a locked account is
   * refused before any hash. A wrong password counts towards the lockout, a right one
   * clears the count.
   */
  async checkPassword(
    signInProviderId: string,
    email: string,
    password: string,
  ): Promise<PasswordCheck> {
    const normalized = normalizeLocalEmail(email);
    const signInAccount = normalized
      ? await this.deps.store.signInAccounts.getByEmail(signInProviderId, normalized)
      : null;
    if (!signInAccount) {
      await this.passwords.verifyDecoy(password);
      return { ok: false, cause: 'unknown' };
    }
    const now = this.deps.clock.now().getTime();
    if (signInAccount.lockedUntil !== null && Date.parse(signInAccount.lockedUntil) > now) {
      this.deps.logger.warn('local sign-in refused: account locked', {
        sign_in_provider: signInProviderId,
      });
      return { ok: false, cause: 'locked' };
    }
    const hash = await this.deps.store.signInAccounts.readSecret(signInAccount.id, 'password');
    const right = hash !== null && (await this.passwords.verify(hash, password));
    if (!right) {
      if (hash === null) await this.passwords.verifyDecoy(password);
      const after = await this.deps.store.signInAccounts.recordFailure(
        signInAccount.id,
        LOCAL_LOCKOUT,
      );
      if (after?.lockedUntil && Date.parse(after.lockedUntil) > now) {
        this.deps.logger.warn('sign-in account locked after too many wrong passwords', {
          sign_in_provider: signInProviderId,
          attempts: after.failedAttempts,
        });
      }
      return { ok: false, cause: 'wrong' };
    }
    if (signInAccount.failedAttempts > 0 || signInAccount.lockedUntil !== null) {
      await this.deps.store.signInAccounts.clearFailures(signInAccount.id);
    }
    return { ok: true, signInAccount };
  }

  async signInAccountOf(
    signInProviderId: string,
    email: string,
  ): Promise<SignInAccountRecord | null> {
    const normalized = normalizeLocalEmail(email);
    return normalized
      ? this.deps.store.signInAccounts.getByEmail(signInProviderId, normalized)
      : null;
  }

  async signInAccountById(id: string): Promise<SignInAccountRecord | null> {
    return this.deps.store.signInAccounts.getById(id);
  }

  async list(signInProviderId: string): Promise<SignInAccountRecord[]> {
    return this.deps.store.signInAccounts.list(signInProviderId);
  }

  /** The unused, unexpired links of an address, newest first. */
  async pendingLinks(signInProviderId: string, email: string): Promise<LocalLinkRecord[]> {
    return this.deps.store.signInAccounts.pendingLinks(signInProviderId, email);
  }

  /** An administrator removes an account: the person can no longer sign in through it. */
  async remove(signInAccountId: string, actor: string): Promise<SignInAccountRecord> {
    const signInAccount = await this.deps.store.signInAccounts.getById(signInAccountId);
    if (!signInAccount) throw new SignInAccountError('sign-in-account-not-found');
    await this.deps.store.signInAccounts.remove(signInAccountId);
    await this.audit(
      actor,
      'sign-in-account-removed',
      signInAccount.signInProvider,
      { email: signInAccount.email },
      null,
    );
    this.deps.logger.info('sign-in account removed', {
      sign_in_provider: signInAccount.signInProvider,
    });
    return signInAccount;
  }

  private async create(
    signInProviderId: string,
    email: string,
    password: string,
    actor: string,
  ): Promise<SignInAccountRecord> {
    const hash = await this.passwords.hash(password);
    const signInAccount = await this.deps.store.signInAccounts.create({
      signInProvider: signInProviderId,
      email,
    });
    if (!signInAccount) throw new SignInAccountError('sign-in-account-exists');
    await this.deps.store.signInAccounts.writeSecret(signInAccount.id, 'password', hash);
    await this.deps.store.signInAccounts.markPasswordChanged(signInAccount.id);
    await this.audit(actor, 'sign-in-account-created', signInProviderId, null, { email });
    this.deps.logger.info('sign-in account created', { sign_in_provider: signInProviderId });
    return signInAccount;
  }

  private async setPassword(
    signInAccount: SignInAccountRecord,
    password: string,
    actor: string,
  ): Promise<void> {
    const hash = await this.passwords.hash(password);
    await this.deps.store.signInAccounts.writeSecret(signInAccount.id, 'password', hash);
    await this.deps.store.signInAccounts.markPasswordChanged(signInAccount.id);
    await this.deps.store.signInAccounts.clearFailures(signInAccount.id);
    await this.audit(actor, 'local-password-changed', signInAccount.signInProvider, null, {
      email: signInAccount.email,
    });
    this.deps.logger.info('sign-in account password changed', {
      sign_in_provider: signInAccount.signInProvider,
    });
  }

  private async audit(
    actor: string,
    act:
      | 'local-link-created'
      | 'sign-in-account-created'
      | 'local-password-changed'
      | 'local-second-factor-changed'
      | 'sign-in-account-removed',
    signInProviderId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    try {
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: actor,
        act,
        object: { type: 'instance-config', id: signInAccountsObjectId(signInProviderId) },
        before,
        after,
      });
    } catch (err) {
      this.deps.logger.error('sign-in accounts: audit write failed', { act, err });
    }
  }
}
