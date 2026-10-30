/**
 * The one guard of every request made with a web session (spec §6 "every
 * mutation requires a valid session and an origin check").
 *
 * Order, the same for every handler:
 *
 *   1. origin check (mutations only)              → `origin-mismatch`
 *   2. a session that is still somebody           → `no-session`
 *      (a session of a revoked bootstrap token or of a disabled user is
 *      nobody: `Authenticator.authenticate` decides)
 *   3. the role the endpoint asks for             → `not-a-user` / `not-an-operator`
 *
 * The guard answers with the principal or with the reason of the refusal;
 * each handler shapes the response its surface answers with (JSON, redirect,
 * page). `refusalResponse` is the JSON shape most of them share — except for a
 * page's form posted without a session (one left open until the session
 * expired): that is sent to sign in, then back to the page it came from.
 */
import type { Authenticator, Principal, UserPrincipal } from './authenticator';
import { resolveReturnTo } from '../http/return-to';
import { forbiddenOriginResponse, isSameOrigin } from './origin';

/** `user`: an identified user (never the bootstrap operator). `operator`: the admin rule. */
export type GuardRole = 'user' | 'operator';

export type GuardRefusalReason =
  'origin-mismatch' | 'no-session' | 'not-a-user' | 'not-an-operator';

export interface GuardRefusal {
  readonly ok: false;
  readonly reason: GuardRefusalReason;
  readonly status: 401 | 403;
  /**
   * `no-session` on a page's form (a top-level navigation): where to sign in,
   * with the page to come back to. Absent for a script's request, which keeps
   * the JSON answer.
   */
  readonly signIn?: string;
}

export interface GuardPass<P extends Principal> {
  readonly ok: true;
  readonly principal: P;
}

export type GuardResult<P extends Principal> = GuardPass<P> | GuardRefusal;

export interface SessionGuardDeps {
  readonly authenticator: Pick<Authenticator, 'authenticate' | 'authorizeAdmin'>;
}

export interface GuardDeps extends SessionGuardDeps {
  readonly publicUrl: URL;
}

const UNAUTHENTICATED = 401;
const FORBIDDEN = 403;
const SEE_OTHER = 303;
const LOGIN_PAGE = '/login';

function refuse(reason: GuardRefusalReason): GuardRefusal {
  return { ok: false, reason, status: reason === 'no-session' ? UNAUTHENTICATED : FORBIDDEN };
}

/** Steps 2 and 3. A `user` pass always carries a user principal: the overloads below say so. */
async function authorize(
  request: Request,
  deps: SessionGuardDeps,
  role: GuardRole,
): Promise<GuardResult<Principal>> {
  const principal = await deps.authenticator.authenticate(request.headers);
  if (!principal) return refuse('no-session');
  if (role === 'user') {
    return principal.kind === 'user' ? { ok: true, principal } : refuse('not-a-user');
  }
  const decision = await deps.authenticator.authorizeAdmin(principal);
  if (decision.ok) return { ok: true, principal: decision.principal };
  return refuse(decision.status === UNAUTHENTICATED ? 'no-session' : 'not-an-operator');
}

/** Steps 2 and 3, for a read: who is behind the request, and whether the endpoint is theirs. */
export async function guardSession(
  request: Request,
  deps: SessionGuardDeps,
  role: 'user',
): Promise<GuardResult<UserPrincipal>>;
export async function guardSession(
  request: Request,
  deps: SessionGuardDeps,
  role: 'operator',
): Promise<GuardResult<Principal>>;
export async function guardSession(
  request: Request,
  deps: SessionGuardDeps,
  role: GuardRole,
): Promise<GuardResult<Principal>> {
  return authorize(request, deps, role);
}

/** Steps 1 to 3, for every mutation: the session of a foreign origin is not even read. */
export async function guardMutation(
  request: Request,
  deps: GuardDeps,
  role: 'user',
): Promise<GuardResult<UserPrincipal>>;
export async function guardMutation(
  request: Request,
  deps: GuardDeps,
  role: 'operator',
): Promise<GuardResult<Principal>>;
export async function guardMutation(
  request: Request,
  deps: GuardDeps,
  role: GuardRole,
): Promise<GuardResult<Principal>> {
  if (!isSameOrigin(request.headers, deps.publicUrl)) return refuse('origin-mismatch');
  const result = await authorize(request, deps, role);
  if (result.ok || result.reason !== 'no-session' || !isNavigation(request)) return result;
  return { ...result, signIn: signInLocation(request, deps.publicUrl) };
}

/** A form a page posted (the browser navigates), not a script's `fetch`. */
function isNavigation(request: Request): boolean {
  return request.headers.get('sec-fetch-mode') === 'navigate';
}

/** The sign-in page, returning to the page the form was on when it is the instance's. */
function signInLocation(request: Request, publicUrl: URL): string {
  const back = resolveReturnTo(request.headers.get('referer'), publicUrl);
  return back ? `${LOGIN_PAGE}?return_to=${encodeURIComponent(back)}` : LOGIN_PAGE;
}

/** How a surface words its JSON refusals: the key of the sentence, and the sentences. */
export interface RefusalWording {
  /** The body is `{ error, <field>: <sentence> }`. */
  readonly field: 'message' | 'reason';
  readonly noSession: string;
  /** The sentence of `not-a-user` or `not-an-operator`, whichever the endpoint's role yields. */
  readonly forbidden: string;
}

/** The wording of the Administration endpoints (`{ error, reason }`). */
export const OPERATOR_REFUSALS: RefusalWording = {
  field: 'reason',
  noSession: 'no session',
  forbidden: 'user is not an administrator of this instance',
};

/** The JSON answer to a refusal; `origin-mismatch` is worded once, in `origin.ts`. */
export function refusalResponse(refusal: GuardRefusal, wording: RefusalWording): Response {
  if (refusal.reason === 'origin-mismatch') return forbiddenOriginResponse();
  if (refusal.signIn) {
    return new Response(null, {
      status: SEE_OTHER,
      headers: { Location: refusal.signIn, 'Cache-Control': 'no-store' },
    });
  }
  const unauthenticated = refusal.reason === 'no-session';
  return new Response(
    JSON.stringify({
      error: unauthenticated ? 'unauthenticated' : 'forbidden',
      [wording.field]: unauthenticated ? wording.noSession : wording.forbidden,
    }),
    {
      status: refusal.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}
