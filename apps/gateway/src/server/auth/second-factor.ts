/**
 * The second factor of every person (spec §6; ADR administrators-live-in-the-instance,
 * §7): the instance's TOTP (RFC 6238) and eight recovery codes, kept per user whatever
 * their sign-in provider. Every sign-in ends with it — the code, or the enrolment when
 * the person has none — unless an administrator waived it for the provider, and never
 * waived for an administrator.
 *
 * The local accounts kept their factor per account (migration 0019); the boot moves it
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
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { UserRecord } from '../store/types';

export interface TotpEnrolment {
  readonly secret: string;
  readonly otpauth: string;
}

export type SecondFactorCheck =
  | { readonly ok: true; readonly by: 'totp' | 'recovery-code'; readonly recoveryCodesLeft: number }
  | { readonly ok: false };

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
  readonly store: Pick<Store, 'secondFactors' | 'localAccounts' | 'users'>;
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

  /** A code of the app (never twice: the step must be later than the last one), or a recovery code. */
  async check(userId: string, code: string): Promise<SecondFactorCheck> {
    if (!(await this.has(userId))) return { ok: false };
    const typed = code.trim();
    const factors = this.deps.store.secondFactors;
    if (/^[\d\s]{6,8}$/.test(typed)) {
      const secret = await factors.readSecret(userId, 'totp');
      const bytes = secret ? base32Decode(secret) : null;
      const step = bytes ? verifyTotp(bytes, typed, this.deps.clock.now().getTime()) : null;
      if (step !== null && (await factors.advanceStep(userId, step))) {
        return { ok: true, by: 'totp', recoveryCodesLeft: await this.recoveryCodesLeft(userId) };
      }
      return { ok: false };
    }
    const raw = await factors.readSecret(userId, 'recovery');
    const digests = raw ? (JSON.parse(raw) as string[]) : [];
    const digest = recoveryCodeDigest(typed);
    if (!digests.includes(digest)) return { ok: false };
    const left = digests.filter((d) => d !== digest);
    await factors.writeSecret(userId, 'recovery', JSON.stringify(left));
    this.deps.logger.info('recovery code used', { left: left.length });
    return { ok: true, by: 'recovery-code', recoveryCodesLeft: left.length };
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
   * Moves the factors local accounts kept per account (migration 0019) to their user:
   * opened with the account's associated data, sealed with the user's, then deleted
   * from the account. Idempotent: an account without a factor is skipped. An account
   * with a factor and no user yet gets its user row first.
   */
  async adoptLocalFactors(localProviderIds: readonly string[]): Promise<number> {
    let moved = 0;
    for (const providerId of localProviderIds) {
      for (const account of await this.deps.store.localAccounts.list(providerId)) {
        if (account.totpConfirmedAt === null) continue;
        const totp = await this.deps.store.localAccounts.readSecret(account.id, 'totp');
        const recovery = await this.deps.store.localAccounts.readSecret(account.id, 'recovery');
        if (totp !== null) {
          const user = await this.deps.store.users.ensureIdentity({
            issuer: localIssuer(providerId).href,
            subject: account.id,
            email: account.email,
          });
          await this.deps.store.secondFactors.set({
            userId: user.id,
            totp,
            recovery: recovery ?? '[]',
            lastStep: account.totpLastStep,
            confirmedAt: account.totpConfirmedAt,
          });
          moved += 1;
        }
        await this.deps.store.localAccounts.deleteSecret(account.id, 'totp');
        await this.deps.store.localAccounts.deleteSecret(account.id, 'recovery');
        await this.deps.store.localAccounts.setTotp(account.id, {
          confirmedAt: null,
          lastStep: null,
        });
      }
    }
    if (moved > 0) {
      this.deps.logger.info('second factors of local accounts moved to their people', { moved });
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
      delegated_client_id: null,
    });
  }
}
