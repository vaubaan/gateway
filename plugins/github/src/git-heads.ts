/**
 * The branch heads of a repository as GitHub lists them now (ADR
 * gateway-as-git-remote D4 ter):
 * the bases both the review and the inspection of a push may use.
 */
import {
  parseAdvertisement,
  UPLOAD_PACK_SERVICE,
  UpstreamHttpError,
  type ExecuteContext,
} from '@vaubaan/plugin-sdk';

import { upstream } from './git-credential.ts';

const BRANCH_PREFIX = 'refs/heads/';

/**
 * The object ids the repository's branches point at now (its upload-pack
 * advertisement): `refs/heads/*` only — never a tag, never a temporary ref
 * of the gateway.
 */
export async function branchHeads(
  ctx: ExecuteContext,
  repository: string,
): Promise<ReadonlySet<string>> {
  const remote = await upstream(ctx, repository, 'read');
  const res = await ctx.fetch(`${remote.url}/info/refs?service=${UPLOAD_PACK_SERVICE}`, {
    method: 'GET',
    headers: { Authorization: remote.authorization },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new UpstreamHttpError(`github info/refs answered HTTP ${res.status}`, res.status);
  }
  const ad = parseAdvertisement(new Uint8Array(await res.arrayBuffer()));
  return new Set(ad.refs.filter((r) => r.name.startsWith(BRANCH_PREFIX)).map((r) => r.oid));
}
