/**
 * Next glue for the Connections pages: the signed-in *user* behind the
 * request with the `Actor` the connection service expects (connections
 * belong to users, never to the bootstrap operator), and the one-time notice
 * a redirect left for the page. Everything that decides lives in
 * `@/server/connections`.
 */
import { currentUser } from '@/lib/auth/session';
import type { UserPrincipal } from '@/server/auth';
import type { GatewayRoot } from '@/server/compose';
import { actorOf, NOTICE_PARAM, type Actor, type Notice } from '@/server/connections';

export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/**
 * `currentUser()` plus the connections `Actor`. Same contract: a visitor with
 * no session is sent to the sign-in, and the bootstrap operator gets `null`,
 * for which the page renders `<NeedsUser />`.
 */
export async function currentActor(): Promise<{
  root: GatewayRoot;
  principal: UserPrincipal;
  actor: Actor;
} | null> {
  const session = await currentUser();
  if (!session) return null;
  return { root: session.root, principal: session.principal, actor: actorOf(session.principal) };
}

/** Reads (once) the notice named by `?notice=<id>` for this web session. */
export async function takeNotice(
  root: GatewayRoot,
  sessionId: string,
  params: Record<string, string | string[] | undefined>,
): Promise<Notice | null> {
  return root.connections.notices.take(sessionId, firstParam(params[NOTICE_PARAM]));
}
