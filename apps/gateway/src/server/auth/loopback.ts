/**
 * Flows of Vaubaan's installed-app clients, back on the loopback (ADR
 * local-instance-carries-installed-oauth-clients). Three steps, three requests:
 *
 *   start      the window that signs in (`POST /auth/loopback/start`) gets the provider's
 *              consent address and a cookie, `vbn_loopback`, that binds the flow to it:
 *              a random binder followed by the flow's `state`. The record, under
 *              `loopback:<state>`, keeps the binder's SHA-256, the PKCE verifier, the
 *              nonce, the purpose and where to land.
 *   callback   the provider sends the browser to `http://127.0.0.1:<port>/oauth/loopback`:
 *              another host than the public URL's `localhost`, so without its cookies.
 *              The record named by `state` is enough to finish the exchange; its outcome
 *              (the identity, or the error) is written into it, then the browser goes on
 *              to the public URL (`/auth/loopback/done`).
 *   take       the window that holds the binder takes the outcome, once: the same
 *              browser on `/auth/loopback/done`, or the desktop app's window, whose
 *              consent opened in the default browser, by polling `/auth/loopback/status`.
 *              A browser without the binder (the default browser of the desktop app, a
 *              replay) takes nothing: it is told to go back to Vaubaan.
 *
 * Nothing is written for the person (user, session, designation) before the take: what
 * the outcome becomes is the purpose's (`complete`), run in the request of the window
 * that started the flow.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SessionStore } from '../compose/ports';
import { errorMessage } from '../config/errors';
import type { AdminGroup, SignInProvider } from '../config/sign-in';
import type { Logger } from '../logging';
import { toIso, type Clock } from '../store/clock';
import type { IdentityClaims } from './claims';
import type { CookieJar } from './cookies';
import { isLoginErrorCode, LoginError, type LoginErrorCode } from './errors';
import type { SignInFlows } from './sign-in-flows';

const MINUTE_MS = 60_000;
/** How long the person has to consent and come back. */
export const LOOPBACK_TTL_MS = 10 * MINUTE_MS;
const KEY_PREFIX = 'loopback:';
/** 32 random bytes in base64url: the binder's fixed length in the cookie. */
const BINDER_LENGTH = 43;
const STATE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/** What the flow is for: signing in, or the first administrator of a local setup. */
export type LoopbackPurpose = 'sign-in' | 'setup';

export type LoopbackOutcome =
  | { readonly identity: IdentityClaims; readonly warnings: readonly string[] }
  | { readonly error: LoginErrorCode };

export interface LoopbackRecord {
  readonly kind: 'loopback';
  readonly purpose: LoopbackPurpose;
  readonly signInProviderId: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  /** Same-origin path to land on (a sign-in). */
  readonly returnTo: string;
  /** SHA-256 (base64url) of the binder the starting window holds. */
  readonly binder: string;
  /** The session that started the flow (the setup's bootstrap session), or `null`. */
  readonly starterSessionId: string | null;
  readonly createdAt: string;
  readonly outcome?: LoopbackOutcome;
}

/** A record whose outcome is known: what `take` hands to the purpose. */
export type FinishedLoopback = LoopbackRecord & { readonly outcome: LoopbackOutcome };

export interface LoopbackServiceDeps {
  readonly store: SessionStore;
  readonly flows: SignInFlows;
  readonly cookies: CookieJar;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface StartedLoopback {
  readonly authorizeUrl: URL;
  readonly setCookie: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is LoopbackRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.kind === 'loopback' &&
    (r.purpose === 'sign-in' || r.purpose === 'setup') &&
    typeof r.signInProviderId === 'string' &&
    typeof r.state === 'string' &&
    typeof r.nonce === 'string' &&
    typeof r.codeVerifier === 'string' &&
    typeof r.returnTo === 'string' &&
    typeof r.binder === 'string' &&
    (r.starterSessionId === null || typeof r.starterSessionId === 'string') &&
    typeof r.createdAt === 'string'
  );
}

export class LoopbackService {
  // single-process only — makes `take` atomic inside one process (the port has no
  // get-and-delete); a local instance is one process.
  private readonly taking = new Set<string>();

  constructor(private readonly deps: LoopbackServiceDeps) {}

  /** Where the provider sends the browser back. */
  redirectUri(): URL {
    return this.deps.flows.loopbackUri();
  }

  /** Starts a flow for the window of this request; the cookie binds it to that window. */
  async start(input: {
    readonly signInProvider: SignInProvider;
    readonly adminGroups: readonly AdminGroup[];
    readonly purpose: LoopbackPurpose;
    readonly returnTo: string;
    readonly starterSessionId: string | null;
  }): Promise<StartedLoopback> {
    const started = await this.deps.flows.for(input.signInProvider, input.adminGroups).start();
    if (!STATE_PATTERN.test(started.state)) {
      throw new LoginError('idp-error', 'the flow started with a state the loopback cannot carry');
    }
    const binder = randomBytes(32).toString('base64url');
    const record: LoopbackRecord = {
      kind: 'loopback',
      purpose: input.purpose,
      signInProviderId: input.signInProvider.id,
      state: started.state,
      nonce: started.nonce,
      codeVerifier: started.codeVerifier,
      returnTo: input.returnTo,
      binder: sha256(binder),
      starterSessionId: input.starterSessionId,
      createdAt: toIso(this.deps.clock.now()),
    };
    await this.deps.store.set(`${KEY_PREFIX}${started.state}`, record, LOOPBACK_TTL_MS);
    return {
      authorizeUrl: started.redirectTo,
      setCookie: this.deps.cookies.serialize('vbn_loopback', `${binder}${started.state}`, {
        maxAgeSeconds: LOOPBACK_TTL_MS / 1000,
      }),
    };
  }

  /**
   * The provider's redirect: finishes the exchange of the flow `state` names, once, and
   * keeps its outcome for the window that started it. `null` when no flow waits under
   * this state (unknown, expired, already finished).
   */
  async callback(
    callback: URL,
    resolve: (id: string) => Promise<SignInProvider | null>,
    adminGroups: (signInProvider: SignInProvider) => Promise<readonly AdminGroup[]>,
  ): Promise<LoopbackRecord | null> {
    const state = callback.searchParams.get('state') ?? '';
    if (!STATE_PATTERN.test(state)) return null;
    const key = `${KEY_PREFIX}${state}`;
    if (this.taking.has(key)) return null;
    this.taking.add(key);
    try {
      const stored = await this.deps.store.get(key);
      if (!isRecord(stored) || stored.outcome !== undefined) return null;
      let outcome: LoopbackOutcome;
      const signInProvider = await resolve(stored.signInProviderId);
      if (!signInProvider) {
        outcome = { error: 'sign-in-provider-unknown' };
      } else {
        try {
          const uri = this.redirectUri();
          uri.search = callback.search;
          const finished = await this.deps.flows
            .for(signInProvider, await adminGroups(signInProvider))
            .finish(uri, stored);
          for (const warning of finished.warnings) {
            this.deps.logger.warn('sign-in warning', { warning });
          }
          outcome = { identity: finished.identity, warnings: finished.warnings };
        } catch (err) {
          const code: LoginErrorCode =
            err instanceof LoginError && isLoginErrorCode(err.code) ? err.code : 'idp-error';
          this.deps.logger.warn('sign-in failed', { code, detail: errorMessage(err) });
          outcome = { error: code };
        }
      }
      const finished: LoopbackRecord = { ...stored, outcome };
      await this.deps.store.set(key, finished, LOOPBACK_TTL_MS);
      return finished;
    } finally {
      this.taking.delete(key);
    }
  }

  /** The outcome of a flow by its state, for the page of a browser that holds no binder. */
  async outcomeOf(state: string): Promise<'pending' | 'done' | LoginErrorCode | null> {
    if (!STATE_PATTERN.test(state)) return null;
    const stored = await this.deps.store.get(`${KEY_PREFIX}${state}`);
    if (!isRecord(stored)) return null;
    if (!stored.outcome) return 'pending';
    return 'error' in stored.outcome ? stored.outcome.error : 'done';
  }

  /**
   * The outcome of the flow this window's cookie binds, taken once: `pending` while the
   * provider has not sent the browser back, `null` when the cookie binds nothing.
   */
  async take(headers: Headers): Promise<FinishedLoopback | 'pending' | null> {
    const value = this.deps.cookies.read(headers, 'vbn_loopback');
    if (!value || value.length <= BINDER_LENGTH) return null;
    const binder = value.slice(0, BINDER_LENGTH);
    const state = value.slice(BINDER_LENGTH);
    if (!STATE_PATTERN.test(state)) return null;
    const key = `${KEY_PREFIX}${state}`;
    if (this.taking.has(key)) return 'pending';
    this.taking.add(key);
    try {
      const stored = await this.deps.store.get(key);
      if (!isRecord(stored) || !sameText(stored.binder, sha256(binder))) return null;
      if (!stored.outcome) return 'pending';
      await this.deps.store.delete(key);
      return stored as FinishedLoopback;
    } finally {
      this.taking.delete(key);
    }
  }

  /** The `Set-Cookie` that forgets this window's flow. */
  clearCookie(): string {
    return this.deps.cookies.clear('vbn_loopback');
  }
}
