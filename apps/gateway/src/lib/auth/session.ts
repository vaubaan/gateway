/**
 * Next glue for the v5 human session: server components call these to learn
 * who is behind the request. Everything that decides lives in `@/server/auth`
 * (host-agnostic); this file only adds `headers()` and Next's navigation.
 */
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import {
  adminSignInPage,
  type AdminDecision,
  type Principal,
  type UserPrincipal,
} from '@/server/auth';
import { getRoot, type GatewayRoot } from '@/server/compose';
import type { UserRecord } from '@/server/store/types';

/** Where a visitor with no session is sent by the pages of the human surface. */
const SIGN_IN_PAGE = '/login';

/**
 * Who is behind the request, or `null`. For the pages that render for anyone
 * (`/`, `/login`, `/admin/bootstrap`) and for layouts; a page of the human
 * surface calls `requirePrincipal()` or `currentUser()` instead.
 */

export async function currentPrincipal(): Promise<{
  root: GatewayRoot;
  principal: Principal | null;
}> {
  const root = await getRoot();
  const principal = await root.auth.authenticator.authenticate(await headers());
  return { root, principal };
}

/**
 * The guard of a page under `(app)` that renders for any session, the
 * bootstrap operator included (the Audit page): returns only to a signed-in
 * visitor, anyone else is sent to the sign-in.
 *
 * Like `requireOperator()`, the page calls it itself: the `(app)` layout is
 * not an authorization boundary.
 */
export async function requirePrincipal(): Promise<{ root: GatewayRoot; principal: Principal }> {
  const { root, principal } = await currentPrincipal();
  if (!principal) redirect(SIGN_IN_PAGE);
  return { root, principal };
}

export interface UserSession {
  readonly root: GatewayRoot;
  readonly principal: UserPrincipal;
  readonly user: UserRecord;
}

/**
 * The guard of a page that needs an identified user (missions, connections,
 * requests), with one answer per case:
 *
 * - no session: redirect to the sign-in;
 * - the bootstrap operator: `null` — the page renders `<NeedsUser />` and
 *   nothing else (the bootstrap token configures the instance; it owns no
 *   mission, no connection and no request);
 * - a signed-in user: the root, the principal and its user record.
 */
export async function currentUser(): Promise<UserSession | null> {
  const { root, principal } = await requirePrincipal();
  if (principal.kind !== 'user') return null;
  return { root, principal, user: principal.user };
}

export async function adminDecision(): Promise<{
  root: GatewayRoot;
  decision: AdminDecision;
  /** Who asked, whatever the decision: a refusal is explained inside their shell. */
  principal: Principal | null;
}> {
  const { root, principal } = await currentPrincipal();
  const decision = await root.auth.authenticator.authorizeAdmin(principal);
  return { root, decision, principal };
}

/**
 * The guard of every page under `/admin`: returns only to an operator.
 *
 * Each page calls it first, before reading anything from the root. The
 * layout of the Administration surface is not an authorization boundary: the
 * App Router can render a page segment without its layout, so a page that
 * relied on the layout would render operator data to anyone.
 *
 * No session: redirect to the sign-in that applies (same target as the
 * layout). Signed in but not an operator: "not found" for the bare page; the
 * layout, when it renders, explains it with its "Not an operator" banner.
 */
export async function requireOperator(): Promise<{ root: GatewayRoot; principal: Principal }> {
  const { root, decision } = await adminDecision();
  if (decision.ok) return { root, principal: decision.principal };
  if (decision.status === 401) redirect(await adminSignInPage(root.auth));
  notFound();
}
