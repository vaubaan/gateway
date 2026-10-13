/**
 * Next glue for the Connections pages: the signed-in *user* behind the
 * request (connections belong to users, never to the bootstrap operator),
 * and the one-time notice a redirect left for the page. Everything that
 * decides lives in `@/server/connections`.
 */
import { redirect } from 'next/navigation';

import { currentPrincipal } from '@/lib/auth/session';
import type { UserPrincipal } from '@/server/auth';
import type { GatewayRoot } from '@/server/compose';
import { actorOf, NOTICE_PARAM, type Actor, type Notice } from '@/server/connections';

export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export async function requireUser(): Promise<{
  root: GatewayRoot;
  principal: UserPrincipal;
  actor: Actor;
}> {
  const { root, principal } = await currentPrincipal();
  if (!principal) redirect('/login');
  // The bootstrap operator configures the instance; they own nothing.
  if (principal.kind !== 'user') redirect('/admin');
  return { root, principal, actor: actorOf(principal) };
}

/** Reads (once) the notice named by `?notice=<id>` for this web session. */
export async function takeNotice(
  root: GatewayRoot,
  sessionId: string,
  params: Record<string, string | string[] | undefined>,
): Promise<Notice | null> {
  return root.connections.notices.take(sessionId, firstParam(params[NOTICE_PARAM]));
}
