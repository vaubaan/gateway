/**
 * The second factor of every person (spec §6; ADR administrators-live-in-the-instance,
 * §7): the instance's TOTP (RFC 6238) and eight recovery codes, kept per user whatever
 * their sign-in provider. Every sign-in ends with it — the code, or the enrolment when
 * the person has none — unless an administrator waived it for the provider, and never
 * waived for an administrator.
 *
 * Lockout: `SECOND_FACTOR_LOCKOUT` wrong codes within its window lock the person's
 * factor for `lockMs`, counted in the store as `LOCAL_LOCKOUT` counts wrong passwords
 * (security audit 2026-10-31, M1): whoever holds the password cannot try codes without
 * end. A locked factor checks no code, not even the right one.
 *
 * The sign-in accounts kept their factor per account (migration 0019); the boot moves it
 * to the account's user once (`adoptLocalFactors`).
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import {
  base32Decode,
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUrl,
  recoveryCodeDigest,
  verifyTotp,
} from '../crypto/totp';
import { localIssuer } from '../config/sign-in';
import type { Logger } from '../logging';
import type { LockoutRule, Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { UserRecord } from '../store/types';

export interface TotpEnrolment {
  readonly secret: string;
  readonly otpauth: string;
}

export type SecondFactorCheck =
  | { readonly ok: true; readonly by: 'totp' | 'recovery-code'; readonly recoveryCodesLeft: number }
  | { readonly ok: false; readonly cause: 'none' | 'wrong' | 'locked' };

const MINUTE_MS = 60_000;

/** Ten wrong codes in fifteen minutes lock the factor for fifteen minutes, as `LOCAL_LOCKOUT`. */
export const SECOND_FACTOR_LOCKOUT: LockoutRule = {
  maxAttempts: 10,
  windowMs: 15 * MINUTE_MS,
  lockMs: 15 * MINUTE_MS,
};

/** How a provider's waiver reads (`ProviderState.waiver`). */
export type SecondFactorWaiver = 'always' | 'amr';

/**
 * Whether a sign-in may go without the instance's factor: never for an administrator;
 * `always` on the administrator's word; `amr` when the ID token says `mfa`.
 */
export function waiverApplies(
  waiver: SecondFactorWaiver | null,
  context: { readonly isOperator: boolean; readonly amr?: readonly string[] },
): boolean {
  if (context.isOperator || waiver === null) return false;
  if (waiver === 'always') return true;
  return context.amr?.includes('mfa') === true;
}

export interface SecondFactorDeps {
  readonly store: Pick<Store, 'secondFactors' | 'signInAccounts' | 'users'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class SecondFactorService {
  constructor(private readonly deps: SecondFactorDeps) {}

  async has(userId: string): Promise<boolean> {
    return (await this.deps.store.secondFactors.get(userId)) !== null;
  }

  /**
   * A fresh secret, the enrolment's first half: kept by the caller (a pending step, a
   * settings step) until one code confirms it. Nothing is stored yet: a factor the
   * person has stays in force until the new one is confirmed.
   */
  beginEnrolment(instanceLabel: string, email: string): TotpEnrolment {
    const secret = generateTotpSecret();
    return { secret, otpauth: otpauthUrl({ issuer: instanceLabel, account: email, secret }) };
  }

  /** The code proves the app holds the secret; the seed and eight recovery codes are sealed. */
  async confirmEnrolment(
    user: Pick<UserRecord, 'id' | 'email'>,
    secret: string,
    code: string,
    actor: string,
  ): Promise<{ recoveryCodes: string[] } | null> {
    const bytes = base32Decode(secret);
    if (!bytes || bytes.length === 0) return null;
    const step = verifyTotp(bytes, code, this.deps.clock.now().getTime());
    if (step === null) return null;
    const recoveryCodes = generateRecoveryCodes();
    await this.deps.store.secondFactors.set({
      userId: user.id,
      totp: secret,
      recovery: JSON.stringify(recoveryCodes.map(recoveryCodeDigest)),
      lastStep: step,
    });
    await this.audit(actor, user, 'enrolled');
    this.deps.logger.info('second factor enrolled');
    return { recoveryCodes };
  }

  /**
   * A code of the app (never twice: the step must be later than the last one), or a
   * recovery code. A wrong one counts towards the lockout, a right one clears the
   * count; while the factor is locked no code is checked.
   */
  async check(userId: string, code: string): Promise<SecondFactorCheck> {
    const factor = await this.deps.store.secondFactors.get(userId);
    if (!factor) return { ok: false, cause: 'none' };
    if (this.isLocked(factor.lockedUntil)) {
      this.deps.logger.warn('second factor refused: locked');
      return { ok: false, cause: 'locked' };
    }
    const accepted = await this.accept(userId, code.trim());
    if (!accepted) return this.recordWrongCode(userId);
    if (factor.failedAttempts > 0) await this.deps.store.secondFactors.clearFailures(userId);
    return accepted;
  }

  /** The code when it is one of the person's: an unused step of the app, or an unused recovery code. */
  private async accept(
    userId: string,
    typed: string,
  ): Promise<Extract<SecondFactorCheck, { ok: true }> | null> {
    const factors = this.deps.store.secondFactors;
    if (/^[\d\s]{6,8}$/.test(typed)) {
      const secret = await factors.readSecret(userId, 'totp');
      const bytes = secret ? base32Decode(secret) : null;
      const step = bytes ? verifyTotp(bytes, typed, this.deps.clock.now().getTime()) : null;
      if (step === null || !(await factors.advanceStep(userId, step))) return null;
      return { ok: true, by: 'totp', recoveryCodesLeft: await this.recoveryCodesLeft(userId) };
    }
    const raw = await factors.readSecret(userId, 'recovery');
    const digests = raw ? (JSON.parse(raw) as string[]) : [];
    const digest = recoveryCodeDigest(typed);
    if (!digests.includes(digest)) return null;
    const left = digests.filter((d) => d !== digest);
    await factors.writeSecret(userId, 'recovery', JSON.stringify(left));
    this.deps.logger.info('recovery code used', { left: left.length });
    return { ok: true, by: 'recovery-code', recoveryCodesLeft: left.length };
  }

  /** One more wrong code; `locked` when it was the one too many. */
  private async recordWrongCode(userId: string): Promise<SecondFactorCheck> {
    const after = await this.deps.store.secondFactors.recordFailure(userId, SECOND_FACTOR_LOCKOUT);
    if (after && this.isLocked(after.lockedUntil)) {
      this.deps.logger.warn('second factor locked after too many wrong codes', {
        attempts: after.failedAttempts,
      });
      return { ok: false, cause: 'locked' };
    }
    return { ok: false, cause: 'wrong' };
  }

  private isLocked(lockedUntil: string | null): boolean {
    return lockedUntil !== null && Date.parse(lockedUntil) > this.deps.clock.now().getTime();
  }

  async recoveryCodesLeft(userId: string): Promise<number> {
    const raw = await this.deps.store.secondFactors.readSecret(userId, 'recovery');
    return raw ? (JSON.parse(raw) as string[]).length : 0;
  }

  /** The person (after a fresh sign-in) or an administrator removes the factor. */
  async reset(user: Pick<UserRecord, 'id' | 'email'>, actor: string): Promise<boolean> {
    const removed = await this.deps.store.secondFactors.remove(user.id);
    if (removed) {
      await this.audit(actor, user, 'reset');
      this.deps.logger.info('second factor reset');
    }
    return removed;
  }

  /**
   * Moves the factors sign-in accounts kept per account (migration 0019) to their user:
   * opened with the account's associated data, sealed with the user's, then deleted
   * from the account. Idempotent: an account without a factor is skipped. An account
   * with a factor and no user yet gets its user row first.
   */
  async adoptLocalFactors(localProviderIds: readonly string[]): Promise<number> {
    let moved = 0;
    for (const providerId of localProviderIds) {
      for (const signInAccount of await this.deps.store.signInAccounts.list(providerId)) {
        if (signInAccount.totpConfirmedAt === null) continue;
        const totp = await this.deps.store.signInAccounts.readSecret(signInAccount.id, 'totp');
        const recovery = await this.deps.store.signInAccounts.readSecret(
          signInAccount.id,
          'recovery',
        );
        if (totp !== null) {
          const user = await this.deps.store.users.ensureIdentity({
            issuer: localIssuer(providerId).href,
            subject: signInAccount.id,
            email: signInAccount.email,
          });
          await this.deps.store.secondFactors.set({
            userId: user.id,
            totp,
            recovery: recovery ?? '[]',
            lastStep: signInAccount.totpLastStep,
            confirmedAt: signInAccount.totpConfirmedAt,
          });
          moved += 1;
        }
        await this.deps.store.signInAccounts.deleteSecret(signInAccount.id, 'totp');
        await this.deps.store.signInAccounts.deleteSecret(signInAccount.id, 'recovery');
        await this.deps.store.signInAccounts.setTotp(signInAccount.id, {
          confirmedAt: null,
          lastStep: null,
        });
      }
    }
    if (moved > 0) {
      this.deps.logger.info('second factors of sign-in accounts moved to their people', { moved });
    }
    return moved;
  }

  private async audit(
    actor: string,
    user: Pick<UserRecord, 'id' | 'email'>,
    change: 'enrolled' | 'reset',
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: actor,
      act: 'second-factor-changed',
      object: { type: 'user', id: user.id },
      before: null,
      after: { email: user.email, change, by: actor === user.id ? 'self' : actor },
    });
  }
}
