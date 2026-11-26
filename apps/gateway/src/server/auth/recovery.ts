/**
 * Recovery by the master key, loudly (spec §6; ADR administrators-live-in-the-instance,
 * §9). For an instance nobody can administer any more — the sign-in provider misconfigured,
 * the last administrator's factor and recovery codes lost, a restore on a host whose
 * providers are gone —, its master key is the way back, and the only one.
 *
 * The key never leaves the browser. The page asks a challenge (32 random bytes, a
 * pending record bound to a cookie, five minutes, single use), derives
 * `K = HKDF-SHA-256(key, salt = "", info = "vaubaan/recovery-proof/v1")` and sends
 * `HMAC-SHA-256(K, "vaubaan-recovery-v1\n" + public origin + "\n" + challenge)`; the
 * instance computes the same with its current key and compares in constant time. A
 * passed proof opens a recovery session (fifteen minutes, its own cookie) that can do
 * one thing: name an administrator (`administrator-recovered`), or set a sign-in
 * account's password (`password-recovered`, ADR amendment 2026-11-26), for an instance
 * that sends no mail and so has no reset link. Either act mails the administrators when
 * the instance sends mail, notifies their devices, and puts a banner on every page for
 * thirty days (`recovery.last`).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { RECOVERY_ACTOR_ID, type AuditWriter } from '@vaubaan/gateway-core';

import type { SessionStore } from '../compose/ports';
import { recoveryProof } from '../crypto';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import { HOST_COOKIES, HOST_PREFIX, type CookieJar } from './cookies';
import {
  ADMINISTRATORS_OBJECT_ID,
  designationView,
  type AdministratorsService,
} from './administrators';
import type { LinkMailer } from './local-handlers';
import { signInAccountsObjectId } from './sign-in-accounts';
import type { NotificationEvents } from '../notifications/events';

/** The names in the `host` jar; the service writes through its own (`RecoveryDeps.cookies`). */
export const CHALLENGE_COOKIE = `${HOST_PREFIX}vbn_recover`;
export const RECOVERY_COOKIE = `${HOST_PREFIX}vbn_recovery`;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const RECOVERY_SESSION_TTL_MS = 15 * 60_000;
/** How long every page says that a recovery happened. */
export const RECOVERY_BANNER_MS = 30 * 24 * 60 * 60_000;
export const RECOVERY_LAST_KEY = 'recovery.last';

interface ChallengeRecord {
  readonly kind: 'recovery-challenge';
  readonly challenge: string;
  readonly createdAt: string;
}

interface RecoverySessionRecord {
  readonly kind: 'recovery-session';
  readonly createdAt: string;
}

/** What `recovery.last` keeps: when, what was done, and to whom (no secret). */
export interface RecoveryRecord {
  readonly at: string;
  readonly act: 'administrator' | 'password';
  readonly named: Record<string, unknown>;
}

export type NameRequest =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'email'; readonly email: string; readonly signInProvider: string }
  | { readonly kind: 'group'; readonly signInProvider: string; readonly group: string };

export interface RecoveryDeps {
  readonly publicUrl: URL;
  /** The current master key: the proof is made with it, never with a previous one. */
  readonly masterKey: Uint8Array;
  readonly sessions: SessionStore;
  readonly store: Pick<Store, 'config' | 'users' | 'groups'>;
  readonly administrators: AdministratorsService;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly mailer?: LinkMailer;
  /** Told once the naming is recorded: every administrator's devices hear of it. */
  readonly notifications?: Pick<NotificationEvents, 'masterKeyRecovered'>;
  /** How the cookies are written: `host` unless the instance is in local mode. */
  readonly cookies?: CookieJar;
}

export class RecoveryService {
  private readonly cookies: CookieJar;

  constructor(private readonly deps: RecoveryDeps) {
    this.cookies = deps.cookies ?? HOST_COOKIES;
  }

  /** The `Set-Cookie` that ends this browser's challenge. */
  clearChallengeCookie(): string {
    return this.cookies.clear('vbn_recover');
  }

  /** A fresh challenge and the cookie that binds it to this browser. */
  async challenge(): Promise<{ challenge: string; setCookie: string }> {
    const id = randomBytes(32).toString('base64url');
    const challenge = randomBytes(32).toString('base64url');
    const record: ChallengeRecord = {
      kind: 'recovery-challenge',
      challenge,
      createdAt: toIso(this.deps.clock.now()),
    };
    await this.deps.sessions.set(`recover:${id}`, record, CHALLENGE_TTL_MS);
    return {
      challenge,
      setCookie: this.cookies.serialize('vbn_recover', id, {
        maxAgeSeconds: CHALLENGE_TTL_MS / 1000,
      }),
    };
  }

  /**
   * Checks the proof against the challenge of this browser (consumed whatever the
   * outcome). A passed proof opens a recovery session; its cookie is returned.
   */
  async prove(headers: Headers, proof: string): Promise<{ setCookie: string } | null> {
    const id = this.cookies.read(headers, 'vbn_recover');
    if (!id) return null;
    const record = (await this.deps.sessions.get(`recover:${id}`)) as ChallengeRecord | null;
    await this.deps.sessions.delete(`recover:${id}`);
    if (!record || record.kind !== 'recovery-challenge') return null;
    const expected = Buffer.from(
      recoveryProof(this.deps.masterKey, this.deps.publicUrl.origin, record.challenge),
    );
    const given = Buffer.from(proof.trim());
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.deps.logger.error('recovery by the master key refused: the proof does not match');
      return null;
    }
    const sessionId = randomBytes(32).toString('base64url');
    const session: RecoverySessionRecord = {
      kind: 'recovery-session',
      createdAt: toIso(this.deps.clock.now()),
    };
    await this.deps.sessions.set(`recovery:${sessionId}`, session, RECOVERY_SESSION_TTL_MS);
    this.deps.logger.warn('recovery by the master key: a recovery session is open');
    return {
      setCookie: this.cookies.serialize('vbn_recovery', sessionId, {
        maxAgeSeconds: RECOVERY_SESSION_TTL_MS / 1000,
      }),
    };
  }

  /** Whether this browser holds an open recovery session. */
  async isOpen(headers: Headers): Promise<boolean> {
    const id = this.cookies.read(headers, 'vbn_recovery');
    if (!id) return false;
    const record = (await this.deps.sessions.get(`recovery:${id}`)) as RecoverySessionRecord | null;
    return record?.kind === 'recovery-session';
  }

  /**
   * The one act of a recovery session: names an administrator, then closes the
   * session. Loud: the audit entry, the mail to the administrators, the banner.
   */
  async name(
    headers: Headers,
    request: NameRequest,
  ): Promise<{ named: Record<string, unknown>; clearCookie: string }> {
    await this.close(headers);
    const administrators = this.deps.administrators;
    let named: Record<string, unknown>;
    if (request.kind === 'user') {
      const user = await this.deps.store.users.getById(request.userId);
      if (!user) throw new Error('unknown user');
      const row =
        (await administrators.grantUser(user.id, RECOVERY_ACTOR_ID, 'recovered')) ??
        (await administrators.designationOfUser(user.id));
      named = { ...(row ? designationView(row) : {}), email: user.email };
    } else if (request.kind === 'email') {
      const row = await administrators.grantEmail(
        request.email,
        request.signInProvider,
        RECOVERY_ACTOR_ID,
        'recovered',
      );
      named = row
        ? designationView(row)
        : { kind: 'email', email: request.email, sign_in_provider: request.signInProvider };
    } else {
      const row = await administrators.grantGroup(
        request.signInProvider,
        request.group,
        RECOVERY_ACTOR_ID,
        'recovered',
      );
      named = row
        ? designationView(row)
        : { kind: 'group', group: request.group, sign_in_provider: request.signInProvider };
    }
    const at = toIso(this.deps.clock.now());
    await this.deps.audit.write({
      kind: 'admin',
      ts: at,
      user_id: RECOVERY_ACTOR_ID,
      act: 'administrator-recovered',
      object: { type: 'instance-config', id: ADMINISTRATORS_OBJECT_ID },
      before: null,
      after: named,
    });
    this.deps.logger.warn('an administrator was named by the master key', {
      kind: String(named.kind ?? request.kind),
    });
    await this.announce({ at, act: 'administrator', named });
    return { named, clearCookie: this.cookies.clear('vbn_recovery') };
  }

  /**
   * The other act of a recovery session: records that the key's holder sets the password
   * of the sign-in account `signInAccount`, and closes the session. The caller sets the
   * password once this returned; a session closed meanwhile throws and nothing is set.
   * As loud as a naming: the audit entry, the mail, the notification, the banner.
   */
  async passwordSet(
    headers: Headers,
    signInAccount: { readonly email: string; readonly signInProvider: string },
  ): Promise<{ clearCookie: string }> {
    await this.close(headers);
    const at = toIso(this.deps.clock.now());
    const named = { email: signInAccount.email };
    await this.deps.audit.write({
      kind: 'admin',
      ts: at,
      user_id: RECOVERY_ACTOR_ID,
      act: 'password-recovered',
      object: { type: 'instance-config', id: signInAccountsObjectId(signInAccount.signInProvider) },
      before: null,
      after: named,
    });
    this.deps.logger.warn('a password was set with the master key');
    await this.announce({ at, act: 'password', named });
    return { clearCookie: this.cookies.clear('vbn_recovery') };
  }

  /** Ends this browser's recovery session; throws when it holds none. */
  private async close(headers: Headers): Promise<void> {
    const id = this.cookies.read(headers, 'vbn_recovery');
    if (!id || !(await this.isOpen(headers))) throw new Error('no recovery session');
    await this.deps.sessions.delete(`recovery:${id}`);
  }

  /** What every act of a recovery leaves: the banner's record, the mail, the notification. */
  private async announce(record: RecoveryRecord): Promise<void> {
    await this.deps.store.config.set(RECOVERY_LAST_KEY, JSON.stringify(record));
    await this.tellAdministrators(record);
    this.deps.notifications?.masterKeyRecovered();
  }

  /** The last recovery, while every page says so (thirty days); `null` otherwise. */
  async banner(): Promise<RecoveryRecord | null> {
    const raw = await this.deps.store.config.get(RECOVERY_LAST_KEY);
    if (!raw) return null;
    try {
      const record = JSON.parse(raw) as RecoveryRecord;
      const age = this.deps.clock.now().getTime() - Date.parse(record.at);
      return age >= 0 && age < RECOVERY_BANNER_MS ? record : null;
    } catch {
      return null;
    }
  }

  private async tellAdministrators(record: RecoveryRecord): Promise<void> {
    const send = this.deps.mailer?.sendNotice?.bind(this.deps.mailer);
    if (!send) return;
    // Every administrator, a locked-out one first of all: they are who must know.
    const people = await this.deps.administrators.withAWayIn({ anyWay: true });
    const password = record.act === 'password';
    const text = [
      password
        ? `On ${record.at}, somebody holding this gateway's master key used it to choose a new password for this sign-in account:`
        : `On ${record.at}, somebody holding this gateway's master key used the recovery page to name an administrator:`,
      JSON.stringify(record.named),
      '',
      'If it was not one of you, the master key is in other hands: rotate it, and review the administrators under Administration → Users.',
    ].join('\n');
    for (const person of people) {
      try {
        await send({
          to: person.email,
          subject: password
            ? 'A password was chosen with the master key'
            : 'An administrator was named with the master key',
          text,
        });
      } catch {
        // Logged by the mailer, without the address.
      }
    }
  }
}
