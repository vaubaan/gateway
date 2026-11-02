/**
 * Recovery by the master key, loudly (spec §6; ADR administrators-live-in-the-instance,
 * §9). For an instance nobody can administer any more — the provider misconfigured,
 * the last administrator's factor and recovery codes lost, a restore on a host whose
 * providers are gone —, its master key is the way back, and the only one.
 *
 * The key never leaves the browser. The page asks a challenge (32 random bytes, a
 * pending record bound to a cookie, five minutes, single use), derives
 * `K = HKDF-SHA-256(key, salt = "", info = "vaubaan/recovery-proof/v1")` and sends
 * `HMAC-SHA-256(K, "vaubaan-recovery-v1\n" + public origin + "\n" + challenge)`; the
 * instance computes the same with its current key and compares in constant time. A
 * passed proof opens a recovery session (fifteen minutes, its own cookie) that can do
 * one thing: name an administrator. The naming writes `administrator-recovered`, mails
 * the administrators when the instance sends mail, and puts a banner on every page for
 * thirty days (`recovery.last`).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { RECOVERY_ACTOR_ID, type AuditWriter } from '@vaubaan/gateway-core';

import type { SessionStore } from '../compose/ports';
import { recoveryProof } from '../crypto';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import { clearCookie, HOST_PREFIX, readCookie, serializeCookie } from './cookies';
import {
  ADMINISTRATORS_OBJECT_ID,
  designationView,
  type AdministratorsService,
} from './administrators';
import type { LinkMailer } from './local-handlers';
import type { NotificationEvents } from '../notifications/events';

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

/** What `recovery.last` keeps: when, and what was named (no secret). */
export interface RecoveryRecord {
  readonly at: string;
  readonly named: Record<string, unknown>;
}

export type NameRequest =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'email'; readonly email: string; readonly provider: string }
  | { readonly kind: 'group'; readonly provider: string; readonly group: string };

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
}

export class RecoveryService {
  constructor(private readonly deps: RecoveryDeps) {}

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
      setCookie: serializeCookie(CHALLENGE_COOKIE, id, { maxAgeSeconds: CHALLENGE_TTL_MS / 1000 }),
    };
  }

  /**
   * Checks the proof against the challenge of this browser (consumed whatever the
   * outcome). A passed proof opens a recovery session; its cookie is returned.
   */
  async prove(headers: Headers, proof: string): Promise<{ setCookie: string } | null> {
    const id = readCookie(headers, CHALLENGE_COOKIE);
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
      setCookie: serializeCookie(RECOVERY_COOKIE, sessionId, {
        maxAgeSeconds: RECOVERY_SESSION_TTL_MS / 1000,
      }),
    };
  }

  /** Whether this browser holds an open recovery session. */
  async isOpen(headers: Headers): Promise<boolean> {
    const id = readCookie(headers, RECOVERY_COOKIE);
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
    const id = readCookie(headers, RECOVERY_COOKIE);
    if (!id || !(await this.isOpen(headers))) throw new Error('no recovery session');
    await this.deps.sessions.delete(`recovery:${id}`);
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
        request.provider,
        RECOVERY_ACTOR_ID,
        'recovered',
      );
      named = row
        ? designationView(row)
        : { kind: 'email', email: request.email, provider: request.provider };
    } else {
      const row = await administrators.grantGroup(
        request.provider,
        request.group,
        RECOVERY_ACTOR_ID,
        'recovered',
      );
      named = row
        ? designationView(row)
        : { kind: 'group', group: request.group, provider: request.provider };
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
      delegated_client_id: null,
    });
    const record: RecoveryRecord = { at, named };
    await this.deps.store.config.set(RECOVERY_LAST_KEY, JSON.stringify(record));
    this.deps.logger.warn('an administrator was named by the master key', {
      kind: String(named.kind ?? request.kind),
    });
    await this.tellAdministrators(record);
    this.deps.notifications?.masterKeyRecovered();
    return { named, clearCookie: clearCookie(RECOVERY_COOKIE) };
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
    const text = [
      `On ${record.at}, somebody holding this gateway's master key used the recovery page to name an administrator:`,
      JSON.stringify(record.named),
      '',
      'If it was not one of you, the master key is in other hands: rotate it, and review the administrators under Administration → Users.',
    ].join('\n');
    for (const person of people) {
      try {
        await send({
          to: person.email,
          subject: 'An administrator was named with the master key',
          text,
        });
      } catch {
        // Logged by the mailer, without the address.
      }
    }
  }
}
