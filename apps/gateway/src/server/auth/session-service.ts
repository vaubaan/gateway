/**
 * Web sessions and pending logins over the `SessionStore` port.
 *
 * A session is an opaque random id in a cookie and a record server-side, so
 * it can be revoked by deleting the row and never carries claims the browser
 * could read. Two record kinds live in the same store under distinct key
 * prefixes: `session:<id>` (a signed-in user, or the bootstrap operator) and
 * `login:<id>` (a sign-in attempt in flight: its provider, state, nonce, PKCE
 * verifier, return path). A session ends `SESSION_TTL_MS` after sign-in whatever
 * the activity (spec §6 "web sessions are short"), and earlier after
 * `SESSION_IDLE_MS` without a request: the record carries `seenAt`, written again
 * at most every `SESSION_TOUCH_MS` (one write per active browser per five minutes).
 *
 * What comes back from the store is `unknown` until a type guard has proven
 * its shape: the rows outlive a restart and an upgrade, and the same store
 * holds other record kinds. A record that fails its guard is deleted and
 * reads as no session.
 */
import { randomBytes } from 'node:crypto';

import type { SessionStore } from '../compose/ports';
import { systemClock, toIso, type Clock } from '../store/clock';
import { clearCookie, LOGIN_COOKIE, readCookie, serializeCookie, SESSION_COOKIE } from './cookies';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** Absolute lifetime of a signed-in session: one working day. */
export const SESSION_TTL_MS = 8 * HOUR_MS;
/**
 * A session nobody used for this long is over, within its absolute lifetime (security
 * review 2026-10-15, auth L1): a cookie left in an unattended browser stops working.
 */
export const SESSION_IDLE_MS = 1 * HOUR_MS;
/** How stale the recorded last use may get before a request writes it again. */
export const SESSION_TOUCH_MS = 5 * MINUTE_MS;
/** How long the browser has to come back from the IdP. */
export const LOGIN_TTL_MS = 10 * MINUTE_MS;
const ID_BYTES = 32;

export interface UserSessionRecord {
  readonly kind: 'user';
  readonly userId: string;
  readonly createdAt: string;
  /** The last request seen with this session (to `SESSION_TOUCH_MS`); absent on an older record. */
  readonly seenAt?: string;
  /** What the IdP said at sign-in, for the UI ("test login" result); authority is NOT read from it. */
  readonly login: {
    readonly email: string;
    readonly groups: readonly string[];
    /** The sign-in provider's id; absent on a session from before several providers. */
    readonly provider?: string;
  };
}

export interface BootstrapSessionRecord {
  readonly kind: 'bootstrap';
  readonly createdAt: string;
  readonly seenAt?: string;
}

export type WebSessionRecord = UserSessionRecord | BootstrapSessionRecord;

export interface PendingLogin {
  /**
   * The sign-in provider the attempt was started for. The callback of another
   * provider never completes it (`state-mismatch`).
   */
  readonly providerId: string;
  readonly state: string;
  /** OpenID Connect only; a GitHub attempt carries none (empty string). */
  readonly nonce: string;
  readonly codeVerifier: string;
  /** Same-origin path to land on after sign-in. */
  readonly returnTo: string;
  /**
   * Set when the attempt is a test of the provider beside the session (ADR
   * administrators-live-in-the-instance, §5): the web session of the tester. The
   * callback then signs nobody in.
   */
  readonly testerSessionId?: string;
  readonly createdAt: string;
}

/**
 * A sign-in between its provider and its session (ADR
 * administrators-live-in-the-instance, §7): the person's second factor is asked, or
 * enrolled when they have none. Any provider: the password of a sign-in account, the
 * callback of an OpenID Connect or GitHub provider. Bound to the browser by the same
 * cookie as a pending sign-in, for the same ten minutes, counted from the step's
 * creation: a step re-issued after a wrong code keeps its `createdAt` (security audit
 * 2026-10-31, M1), so retries never extend it. Settings → Security uses the same
 * record for an enrolment in progress.
 */
export interface PendingLocalStep {
  readonly kind: 'local-step';
  readonly step: 'second-factor' | 'enrol';
  readonly providerId: string;
  /** The person signing in (their `users` row exists: the sign-in was admitted). */
  readonly userId: string;
  /** What the session records of the sign-in, for display (`UserSessionRecord.login`). */
  readonly login: { readonly email: string; readonly groups: readonly string[] };
  readonly returnTo: string;
  /** The secret being enrolled, base32, until the first code confirms it. */
  readonly totpSecret?: string;
  readonly createdAt: string;
}

export interface IssuedCookie {
  readonly id: string;
  /** Value for a `Set-Cookie` header. */
  readonly setCookie: string;
}

export interface ReadSession {
  readonly id: string;
  readonly record: WebSessionRecord;
}

export function newSessionId(): string {
  return randomBytes(ID_BYTES).toString('base64url');
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function isWebSessionRecord(value: unknown): value is WebSessionRecord {
  if (!isObject(value) || typeof value.createdAt !== 'string') return false;
  if (value.seenAt !== undefined && typeof value.seenAt !== 'string') return false;
  if (value.kind === 'bootstrap') return true;
  if (value.kind !== 'user' || typeof value.userId !== 'string') return false;
  const { login } = value;
  return (
    isObject(login) &&
    typeof login.email === 'string' &&
    isStringArray(login.groups) &&
    (login.provider === undefined || typeof login.provider === 'string')
  );
}

export function isPendingLocalStep(value: unknown): value is PendingLocalStep {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === 'local-step' &&
    (v.step === 'second-factor' || v.step === 'enrol') &&
    typeof v.providerId === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.login === 'object' &&
    v.login !== null &&
    typeof (v.login as Record<string, unknown>).email === 'string' &&
    typeof v.returnTo === 'string' &&
    (v.totpSecret === undefined || typeof v.totpSecret === 'string') &&
    typeof v.createdAt === 'string'
  );
}

export function isPendingLogin(value: unknown): value is PendingLogin {
  return (
    isObject(value) &&
    typeof value.providerId === 'string' &&
    typeof value.state === 'string' &&
    typeof value.nonce === 'string' &&
    typeof value.codeVerifier === 'string' &&
    typeof value.returnTo === 'string' &&
    (value.testerSessionId === undefined || typeof value.testerSessionId === 'string') &&
    typeof value.createdAt === 'string'
  );
}

export class SessionService {
  private readonly clock: Clock;

  constructor(
    private readonly store: SessionStore,
    clock: Clock = systemClock,
  ) {
    this.clock = clock;
  }

  async create(
    record: Omit<UserSessionRecord, 'createdAt'> | Omit<BootstrapSessionRecord, 'createdAt'>,
  ): Promise<IssuedCookie> {
    const id = newSessionId();
    const full: WebSessionRecord = { ...record, createdAt: toIso(this.clock.now()) };
    await this.store.set(sessionKey(id), full, SESSION_TTL_MS);
    return {
      id,
      setCookie: serializeCookie(SESSION_COOKIE, id, { maxAgeSeconds: SESSION_TTL_MS / 1000 }),
    };
  }

  async read(headers: Headers): Promise<ReadSession | null> {
    const id = readCookie(headers, SESSION_COOKIE);
    if (!id) return null;
    const record = await this.readGuarded(sessionKey(id), isWebSessionRecord);
    if (!record) return null;
    const now = this.clock.now().getTime();
    const seen = Date.parse(record.seenAt ?? record.createdAt);
    if (!Number.isFinite(seen) || now - seen >= SESSION_IDLE_MS) {
      await this.destroyById(id);
      return null;
    }
    if (now - seen < SESSION_TOUCH_MS) return { id, record };
    // Written again with what is left of its absolute lifetime: idle use never extends it.
    const left = Date.parse(record.createdAt) + SESSION_TTL_MS - now;
    if (left <= 0) {
      await this.destroyById(id);
      return null;
    }
    const touched: WebSessionRecord = { ...record, seenAt: toIso(new Date(now)) };
    await this.store.set(sessionKey(id), touched, left);
    return { id, record: touched };
  }

  async destroyById(id: string): Promise<void> {
    await this.store.delete(sessionKey(id));
  }

  /** Deletes the session named by the cookie (if any) and returns the clearing `Set-Cookie`. */
  async destroy(headers: Headers): Promise<string> {
    const id = readCookie(headers, SESSION_COOKIE);
    if (id) await this.destroyById(id);
    return clearCookie(SESSION_COOKIE);
  }

  async createPending(pending: Omit<PendingLogin, 'createdAt'>): Promise<IssuedCookie> {
    const id = newSessionId();
    const full: PendingLogin = { ...pending, createdAt: toIso(this.clock.now()) };
    await this.store.set(loginKey(id), full, LOGIN_TTL_MS);
    return {
      id,
      setCookie: serializeCookie(LOGIN_COOKIE, id, { maxAgeSeconds: LOGIN_TTL_MS / 1000 }),
    };
  }

  /** Reads and consumes the pending login of the request (single use). */
  async takePending(headers: Headers): Promise<PendingLogin | null> {
    const id = readCookie(headers, LOGIN_COOKIE);
    if (!id) return null;
    const pending = await this.readGuarded(loginKey(id), isPendingLogin);
    if (pending) await this.store.delete(loginKey(id));
    return pending;
  }

  clearPendingCookie(): string {
    return clearCookie(LOGIN_COOKIE);
  }

  /** The step between a sign-in account's password and its session; same cookie, same lifetime. */
  async createLocalStep(step: Omit<PendingLocalStep, 'kind' | 'createdAt'>): Promise<IssuedCookie> {
    const id = newSessionId();
    const full: PendingLocalStep = {
      kind: 'local-step',
      ...step,
      createdAt: toIso(this.clock.now()),
    };
    await this.store.set(loginKey(id), full, LOGIN_TTL_MS);
    return {
      id,
      setCookie: serializeCookie(LOGIN_COOKIE, id, { maxAgeSeconds: LOGIN_TTL_MS / 1000 }),
    };
  }

  /**
   * The same step under a new cookie, after a wrong code: its `createdAt` and so its
   * end are kept. `null` when its ten minutes are over.
   */
  async reissueLocalStep(step: PendingLocalStep): Promise<IssuedCookie | null> {
    const left = this.localStepTimeLeft(step);
    if (left <= 0) return null;
    const id = newSessionId();
    await this.store.set(loginKey(id), step, left);
    return {
      id,
      setCookie: serializeCookie(LOGIN_COOKIE, id, { maxAgeSeconds: Math.ceil(left / 1000) }),
    };
  }

  /** Reads the step without consuming it (the page that asks for the code). */
  async peekLocalStep(headers: Headers): Promise<PendingLocalStep | null> {
    const id = readCookie(headers, LOGIN_COOKIE);
    if (!id) return null;
    const step = await this.readGuarded(loginKey(id), isPendingLocalStep);
    return step && this.localStepTimeLeft(step) > 0 ? step : null;
  }

  /** Reads and consumes the step (the form that answers it); an outlived one reads as none. */
  async takeLocalStep(headers: Headers): Promise<PendingLocalStep | null> {
    const id = readCookie(headers, LOGIN_COOKIE);
    if (!id) return null;
    const step = await this.readGuarded(loginKey(id), isPendingLocalStep);
    if (!step) return null;
    await this.store.delete(loginKey(id));
    return this.localStepTimeLeft(step) > 0 ? step : null;
  }

  /** What is left of a step's ten minutes, whatever the store's own expiry says. */
  private localStepTimeLeft(step: PendingLocalStep): number {
    const created = Date.parse(step.createdAt);
    if (!Number.isFinite(created)) return 0;
    return created + LOGIN_TTL_MS - this.clock.now().getTime();
  }

  /** The value under `key` when it has the expected shape; otherwise the key is deleted. */
  private async readGuarded<T>(
    key: string,
    guard: (value: unknown) => value is T,
  ): Promise<T | null> {
    const value: unknown = await this.store.get(key);
    if (value === null || value === undefined) return null;
    if (guard(value)) return value;
    await this.store.delete(key);
    return null;
  }
}

function sessionKey(id: string): string {
  return `session:${id}`;
}

function loginKey(id: string): string {
  return `login:${id}`;
}
