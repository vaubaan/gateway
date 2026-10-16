/**
 * Classifier of the `cloudflare-dns` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md
 *        §10 ("a classification error is a security hole").
 *
 * Pure : no IO, no credential, no `Date`. Every zone-scoped slice is rooted
 * at `cloudflare-dns.account[<account id>].zone[<zone id>]` where the zone is
 * the mission resource the call targets (`zone_id` argument, or the single
 * zone of the mission) and the account id comes from that resource's
 * metadata (`*` when unknown).
 *
 * Conventions :
 *
 *   1. **Layered record writes.** Every record write emits `record[R].W`
 *      (risk `record-write`), or for a deletion `record[R].delete.W` (risk
 *      `record-delete`), which the recursive `record[**].W` pattern
 *      co-matches. A create, update **or deletion** of an apex, wildcard, MX
 *      or NS record also emits `record[R].critical.W` (risk
 *      `critical-record-write`). A mission therefore needs `record-write`
 *      for any record change, and the specific risks on top for the
 *      sensitive ones.
 *   2. **Sensitivity from the arguments, conservatively.** `type` and `name`
 *      decide ; when either is missing the write is critical — a
 *      `delete_record` that only carries `record_id` is a critical write.
 *      `execute` verifies the declared sensitivity against the record's
 *      current state before an update or a deletion.
 *   3. **`list_zones` is account-wide.** It emits `zone[*].R` on the account
 *      shared by the mission's zones (or `account[*]`) ; `execute` filters
 *      the upstream answer to the mission's zones.
 *   4. Identifiers that reach the request path (`zone_id`, `record_id`) must
 *      pass `pathIdent` — one path segment, no dot, no separator — the same
 *      function `execute` applies ; a malformed one is `denied`, never
 *      escaped.
 */

import {
  declaredArgumentsOf,
  undeclaredArgumentDenial,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import {
  CLOUDFLARE_DNS_PROVIDER,
  accountIdOf,
  pathIdent,
  recordSensitivity,
  resolveZoneResource,
  zoneNameOf,
} from './resources.ts';
import { cloudflareDnsTools } from './tools.ts';

const KNOWN_TOOLS: ReadonlySet<string> = new Set(cloudflareDnsTools.map((t) => t.name));
/** `execute` builds its query string and its JSON body from the arguments: the surface is closed here. */
const DECLARED_ARGUMENTS = declaredArgumentsOf(cloudflareDnsTools);

/**
 * The refusal for an argument `tool` does not declare, `null` when there is none :
 * the one rule `classify` and `execute` both apply, so neither side sends what the
 * other never read.
 */
export function undeclaredArgument(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): string | null {
  return undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
}

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: CLOUDFLARE_DNS_PROVIDER, path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

type RecordIdent = { readonly segment: SliceSegment } | { readonly denied: string };

/** The `record_id` argument as an ident segment ; required and path-safe. */
function recordIdent(args: Readonly<Record<string, unknown>>): RecordIdent {
  const value = args.record_id;
  if (value === undefined || value === null || value === '')
    return { denied: 'record_id: missing' };
  const recordId = pathIdent(value);
  if (recordId === null) return { denied: 'record_id: malformed identifier' };
  return { segment: ident(recordId) };
}

function accountSegment(resource: Resource): SliceSegment {
  const id = accountIdOf(resource);
  return id === null ? ANY_IDENT : ident(id);
}

export function classifyCloudflareDns(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  if (!KNOWN_TOOLS.has(tool)) return { denied: `unknown cloudflare-dns tool '${tool}'.` };

  if (tool === 'cloudflare_dns__list_zones') {
    const own = resources.filter((r) => r.provider === CLOUDFLARE_DNS_PROVIDER);
    if (own.length === 0) return { denied: 'the mission touches no Cloudflare DNS zone' };
    const undeclared = undeclaredArgument(tool, args);
    if (undeclared !== null) return { denied: undeclared };
    const accounts = new Set(own.map((r) => accountIdOf(r)));
    const [only] = accounts;
    const account = accounts.size === 1 && only ? ident(only) : ANY_IDENT;
    return { slices: [slice('R', [name('account'), account, name('zone'), ANY_IDENT])] };
  }

  const target = resolveZoneResource(args, resources);
  if ('denied' in target) return target;
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared !== null) return { denied: undeclared };
  const zone = target.resource;
  const root: readonly SliceSegment[] = [
    name('account'),
    accountSegment(zone),
    name('zone'),
    ident(zone.ref),
  ];

  switch (tool) {
    // ─── Reads ────────────────────────────────────────────────────────────
    case 'cloudflare_dns__get_zone':
      return { slices: [slice('R', root)] };
    case 'cloudflare_dns__list_records':
      return { slices: [slice('R', [...root, name('record'), ANY_IDENT])] };
    case 'cloudflare_dns__get_record': {
      const record = recordIdent(args);
      if ('denied' in record) return record;
      return { slices: [slice('R', [...root, name('record'), record.segment])] };
    }
    case 'cloudflare_dns__export_records':
      return { slices: [slice('R', [...root, name('zone-export')])] };
    case 'cloudflare_dns__get_zone_settings':
      return { slices: [slice('R', [...root, name('zone-settings')])] };
    case 'cloudflare_dns__get_dnssec':
      return { slices: [slice('R', [...root, name('dnssec')])] };

    // ─── Writes — records ─────────────────────────────────────────────────
    case 'cloudflare_dns__create_record': {
      const slices = [slice('W', [...root, name('record')])];
      if (recordSensitivity(args, zoneNameOf(zone)) === 'critical') {
        slices.push(slice('W', [...root, name('record'), name('critical')]));
      }
      return { slices };
    }
    case 'cloudflare_dns__update_record': {
      const record = recordIdent(args);
      if ('denied' in record) return record;
      const slices = [slice('W', [...root, name('record'), record.segment])];
      if (recordSensitivity(args, zoneNameOf(zone)) === 'critical') {
        slices.push(slice('W', [...root, name('record'), record.segment, name('critical')]));
      }
      return { slices };
    }
    case 'cloudflare_dns__delete_record': {
      const record = recordIdent(args);
      if ('denied' in record) return record;
      const slices = [slice('W', [...root, name('record'), record.segment, name('delete')])];
      // Deleting the apex, the MX set or a delegation has the effect the
      // critical risk describes ; an undeclared record counts as critical.
      if (recordSensitivity(args, zoneNameOf(zone)) === 'critical') {
        slices.push(slice('W', [...root, name('record'), record.segment, name('critical')]));
      }
      return { slices };
    }
    case 'cloudflare_dns__import_records':
      return { slices: [slice('W', [...root, name('zone-import')])] };

    // ─── Writes — zone-level ──────────────────────────────────────────────
    case 'cloudflare_dns__edit_zone_settings':
      return { slices: [slice('W', [...root, name('zone-settings')])] };
    case 'cloudflare_dns__purge_cache':
      return { slices: [slice('W', [...root, name('cache')])] };
    case 'cloudflare_dns__edit_dnssec':
      return { slices: [slice('W', [...root, name('dnssec')])] };
    case 'cloudflare_dns__delete_zone':
      return { slices: [slice('W', root)] };

    default:
      return { denied: `unknown cloudflare-dns tool '${tool}'.` };
  }
}
