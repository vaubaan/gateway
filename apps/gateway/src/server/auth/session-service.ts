/**
 * Web sessions and pending logins over the `SessionStore` port.
 *
 * A session is an opaque random id in a cookie and a record server-side, so
 * it can be revoked by deleting the row and never carries claims the browser
 * could read. Two record kinds live in the same store under distinct key
 * prefixes: `session:<id>` (a signed-in user, or the bootstrap operator) and
 * `login:<id>` (an OIDC attempt in flight: state, nonce, PKCE verifier,
 * return path). TTLs are absolute (no sliding window): a session ends
 * `SESSION_TTL_MS` after sign-in whatever the activity (spec §6 "web sessions
 * are short").
 */
import { randomBytes } from 'node:crypto';

import type { SessionStore } from '../compose/ports';
import { systemClock, toIso, type Clock } from '../store/clock';
import { clearCookie, LOGIN_COOKIE, readCookie, serializeCookie, SESSION_COOKIE } from './cookies';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** Absolute lifetime of a signed-in session: one working day. */
export const SESSION_TTL_MS = 8 * HOUR_MS;
/** How long the browser has to come back from the IdP. */
export const LOGIN_TTL_MS = 10 * MINUTE_MS;
const ID_BYTES = 32;

export interface UserSessionRecord {
  readonly kind: 'user';
  readonly userId: string;
  readonly createdAt: string;
  /** What the IdP said at sign-in, for the UI ("test login" result); authority is NOT read from it. */
  readonly login: { readonly email: string; readonly groups: readonly string[] };
}

export interface BootstrapSessionRecord {
  readonly kind: 'bootstrap';
  readonly createdAt: string;
}

export type WebSessionRecord = UserSessionRecord | BootstrapSessionRecord;

export interface PendingLogin {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  /** Same-origin path to land on after sign-in. */
  readonly returnTo: string;
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
    const record = (await this.store.get(sessionKey(id))) as WebSessionRecord | null;
    return record ? { id, record } : null;
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
    const pending = (await this.store.get(loginKey(id))) as PendingLogin | null;
    if (pending) await this.store.delete(loginKey(id));
    return pending;
  }

  clearPendingCookie(): string {
    return clearCookie(LOGIN_COOKIE);
  }
}

function sessionKey(id: string): string {
  return `session:${id}`;
}

function loginKey(id: string): string {
  return `login:${id}`;
}
