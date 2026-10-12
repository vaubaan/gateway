/**
 * Shared host-loading + SSH exec helpers used by every REST route that
 * runs a command on a bash-binding host.
 *
 * Why this file exists : `run-tool/route.ts` and `hosts/[hostId]/test/route.ts`
 * both need to (a) load a host scoped to its binding **and** the caller's
 * org, (b) decode the PEM stored as bytea, (c) run a command via SSH and
 * return the result. Inlining that sequence in each route duplicated a
 * security-sensitive code path : an authz tightening on one side would
 * silently miss the other. Pulling it here centralises the org-scope
 * check and the bytea/PEM decoding.
 *
 * The functions stay thin (one supabase select each + one `sshExec`) ;
 * routes still own status code mapping and audit logging.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sshExec, type ExecResult } from '@vaubaan/plugin-ssh';
import { decodeBytea } from '@/lib/providers/bytea';

/**
 * Row returned by `loadHostByIdInOrg` / `loadHostBySlugInOrg` — the
 * canonical shape of a `ssh_bindings` row carrying everything `execOnHost`
 * needs. Note `ssh_private_key` is `unknown` because supabase returns
 * bytea as either a `\x…` hex string or a `Buffer`-like value ; the
 * decoder handles both.
 */
export interface BashHostRow {
  id: string;
  host_address: string;
  port: number;
  ssh_user: string;
  ssh_private_key: unknown;
}

const HOST_SELECT =
  'id, host_address, port, ssh_user, ssh_private_key, bash_bindings!inner(projects!inner(organization_id))';

interface HostJoinedRow extends BashHostRow {
  bash_bindings: { projects: { organization_id: string } };
}

/**
 * Load a host by its primary key, scoped to a binding and to an org.
 * Returns `null` when not found OR when the host belongs to another org —
 * collapsing the two cases is intentional (don't leak existence).
 */
export async function loadHostByIdInOrg(
  svc: SupabaseClient,
  args: { hostId: string; bindingId: string; orgId: string },
): Promise<BashHostRow | null> {
  const { data } = await svc
    .from('ssh_bindings')
    .select(HOST_SELECT)
    .eq('id', args.hostId)
    .eq('bash_binding_id', args.bindingId)
    .maybeSingle<HostJoinedRow>();
  if (!data) return null;
  if (data.bash_bindings.projects.organization_id !== args.orgId) return null;
  return stripJoinKeys(data);
}

/**
 * Load a host by its `host_slug`, scoped to a binding and to an org.
 * Same null-collapsing rule as `loadHostByIdInOrg`.
 */
export async function loadHostBySlugInOrg(
  svc: SupabaseClient,
  args: { hostSlug: string; bindingId: string; orgId: string },
): Promise<BashHostRow | null> {
  const { data } = await svc
    .from('ssh_bindings')
    .select(HOST_SELECT)
    .eq('bash_binding_id', args.bindingId)
    .eq('host_slug', args.hostSlug)
    .maybeSingle<HostJoinedRow>();
  if (!data) return null;
  if (data.bash_bindings.projects.organization_id !== args.orgId) return null;
  return stripJoinKeys(data);
}

/**
 * Discriminated result of `execOnHost` — separates the structured outcome
 * (sshExec returned) from the "key corrupt / decode failure" path so the
 * caller can map either to its own HTTP status code without re-implementing
 * the bytea check.
 */
export type ExecOnHostResult =
  | { ok: true; result: ExecResult }
  | { ok: false; reason: 'invalid-key' };

/**
 * Decode the bytea-stored PEM, then run `cmd` via SSH. Throws on transport
 * failures (timeout, unreachable) so the caller can map them to a 5xx ;
 * returns `{ ok: false, reason: 'invalid-key' }` for the corrupt-key path
 * since that's a 500-not-an-exception condition.
 */
export async function execOnHost(
  host: BashHostRow,
  cmd: string,
  timeout_s: number,
): Promise<ExecOnHostResult> {
  const keyBytes = decodeBytea(host.ssh_private_key);
  if (!keyBytes) return { ok: false, reason: 'invalid-key' };
  const result = await sshExec(
    {
      host_address: host.host_address,
      port: host.port,
      ssh_user: host.ssh_user,
      ssh_private_key_pem: new TextDecoder().decode(keyBytes),
    },
    cmd,
    timeout_s,
  );
  return { ok: true, result };
}

function stripJoinKeys(row: HostJoinedRow): BashHostRow {
  return {
    id: row.id,
    host_address: row.host_address,
    port: row.port,
    ssh_user: row.ssh_user,
    ssh_private_key: row.ssh_private_key,
  };
}
