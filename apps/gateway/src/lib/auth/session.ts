/**
 * Next glue for the v5 human session: server components call these to learn
 * who is behind the request. Everything else lives in `@/server/auth`
 * (host-agnostic); this file only adds `headers()`.
 */
import { headers } from 'next/headers';

import type { AdminDecision, Principal } from '@/server/auth';
import { getRoot, type GatewayRoot } from '@/server/compose';

export async function currentPrincipal(): Promise<{
  root: GatewayRoot;
  principal: Principal | null;
}> {
  const root = await getRoot();
  const principal = await root.auth.authenticator.authenticate(await headers());
  return { root, principal };
}

export async function adminDecision(): Promise<{ root: GatewayRoot; decision: AdminDecision }> {
  const { root, principal } = await currentPrincipal();
  const decision = await root.auth.authenticator.authorizeAdmin(principal);
  return { root, decision };
}
