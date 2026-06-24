/**
 * Cloudflare DNS v4 risk-based classifier — maps a concrete `(tool, args,
 * bindings)` call to the set of slices the runtime intersects with the
 * risk catalog.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7.
 * Research : .vaubaan/research/providers/cloudflare-dns.md §2.
 *
 * Cloudflare DNS is simpler than Stripe or Gmail :
 *
 *   1. **No mode (no envScopable)** — DNS has no test/live namespace.
 *      The classifier does not inject a mode segment. Root prefix is
 *      simply `[name('account'), acct]`.
 *
 *   2. **Binding resource_ref = account_id** — the Cloudflare account_id
 *      is resolved from `binding.resource_ref`. One API Token may cover
 *      multiple zones under that account.
 *
 *   3. **zone_id from args** — most tools take a `zone_id` arg that
 *      narrows the slice to a specific zone. When absent, wildcard.
 *
 *   4. **delete_record and update_record share risk `record-write`** —
 *      both are posture-shifts on a single DNS record.
 *
 *   5. **purge_everything and purge by URL share risk `cache-purge`** —
 *      both hit the cache entity at zone level.
 *
 *   6. **zone-delete is a zone-level write** — the slice stops at
 *      `zone[Z].W` (no sub-entity), distinct from record/settings writes.
 *
 * 15 tools supported (7 reads + 8 writes). Tools outside this list are
 * rejected with `denied` at this layer ; if they reach the runtime via a
 * non-classifier path, the fallback risk `cloudflare-dns.uncategorized-write`
 * catches them (fail-loud by design).
 */

import type { ProviderBinding, Slice, SliceSegment } from '@vaubaan/shared';

export type ClassifyResult = { slices: Slice[] } | { denied: string };

// ─── Slice helpers ─────────────────────────────────────────────────────────

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: 'cloudflare-dns', path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

// ─── Binding plumbing ──────────────────────────────────────────────────────

function pickCloudflareDnsBinding(
  bindings: ReadonlyArray<ProviderBinding>,
): ProviderBinding | null {
  return bindings.find((b) => b.provider === 'cloudflare-dns') ?? null;
}

/** Resolve the account ident segment from the binding's `resource_ref`
 *  (the Cloudflare account_id). Falls back to `*` when absent so the
 *  classifier stays robust during the early binding-bootstrap. */
function accountSeg(binding: ProviderBinding): SliceSegment {
  const ref = binding.resource_ref;
  return typeof ref === 'string' && ref.length > 0 ? ident(ref) : ANY_IDENT;
}

/** Read a string arg uniformly (returns `null` when missing/empty). */
function strArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Resolve an ident segment from a string arg, with `*` fallback. */
function identArg(args: Record<string, unknown>, key: string): SliceSegment {
  const v = strArg(args, key);
  return v !== null ? ident(v) : ANY_IDENT;
}

// ─── Classifier ────────────────────────────────────────────────────────────

/**
 * Classify a Cloudflare DNS tool call into the slice(s) it touches.
 *
 * Returns `{ slices: Slice[] }` on success — the runtime intersects each
 * slice with the catalog. Returns `{ denied: string }` for an unknown tool
 * or when no Cloudflare DNS binding is attached.
 *
 * The 15 supported tools cover DNS management : zone listing, record CRUD,
 * zone settings, DNSSEC, cache purge, BIND import/export, and zone delete.
 * Tools outside this list are rejected with `denied` at this layer.
 */
export function classifyCloudflareDnsV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const binding = pickCloudflareDnsBinding(bindings);
  if (!binding) {
    return { denied: 'no cloudflare-dns binding is attached to this token.' };
  }
  const acct = accountSeg(binding);

  /** Shorthand : build the `account[A]` prefix common to every
   *  Cloudflare DNS slice. Returns a fresh array. */
  const root: readonly SliceSegment[] = [name('account'), acct];

  switch (tool) {
    // ─── READS ────────────────────────────────────────────────────────────
    case 'cloudflare_dns__list_zones':
      return {
        slices: [slice('R', [...root, name('zone'), ANY_IDENT])],
      };

    case 'cloudflare_dns__get_zone': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('R', [...root, name('zone'), zone])],
      };
    }

    case 'cloudflare_dns__list_records': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('R', [...root, name('zone'), zone, name('record'), ANY_IDENT])],
      };
    }

    case 'cloudflare_dns__get_record': {
      const zone = identArg(args, 'zone_id');
      const rec = identArg(args, 'record_id');
      return {
        slices: [slice('R', [...root, name('zone'), zone, name('record'), rec])],
      };
    }

    case 'cloudflare_dns__export_records': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('R', [...root, name('zone'), zone, name('zone-export')])],
      };
    }

    case 'cloudflare_dns__get_zone_settings': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('R', [...root, name('zone'), zone, name('zone-settings')])],
      };
    }

    case 'cloudflare_dns__get_dnssec': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('R', [...root, name('zone'), zone, name('dnssec')])],
      };
    }

    // ─── WRITES — DNS RECORDS ─────────────────────────────────────────────
    case 'cloudflare_dns__create_record': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('W', [...root, name('zone'), zone, name('record')])],
      };
    }

    case 'cloudflare_dns__update_record': {
      const zone = identArg(args, 'zone_id');
      const rec = identArg(args, 'record_id');
      return {
        slices: [slice('W', [...root, name('zone'), zone, name('record'), rec])],
      };
    }

    case 'cloudflare_dns__delete_record': {
      const zone = identArg(args, 'zone_id');
      const rec = identArg(args, 'record_id');
      return {
        slices: [slice('W', [...root, name('zone'), zone, name('record'), rec])],
      };
    }

    case 'cloudflare_dns__import_records': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('W', [...root, name('zone'), zone, name('zone-import')])],
      };
    }

    // ─── WRITES — ZONE SETTINGS ───────────────────────────────────────────
    case 'cloudflare_dns__edit_zone_settings': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('W', [...root, name('zone'), zone, name('zone-settings')])],
      };
    }

    // ─── WRITES — CACHE PURGE ─────────────────────────────────────────────
    case 'cloudflare_dns__purge_cache': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('W', [...root, name('zone'), zone, name('cache')])],
      };
    }

    // ─── WRITES — DNSSEC ──────────────────────────────────────────────────
    case 'cloudflare_dns__edit_dnssec': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('W', [...root, name('zone'), zone, name('dnssec')])],
      };
    }

    // ─── WRITES — ZONE DELETE ─────────────────────────────────────────────
    case 'cloudflare_dns__delete_zone': {
      const zone = identArg(args, 'zone_id');
      return {
        slices: [slice('W', [...root, name('zone'), zone])],
      };
    }

    default:
      return { denied: `unknown cloudflare-dns tool '${tool}'.` };
  }
}
