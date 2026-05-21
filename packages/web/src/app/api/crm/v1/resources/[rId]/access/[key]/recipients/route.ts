/**
 * GET /api/crm/v1/resources/:rId/access/:key/recipients
 *
 * Returns the default recipient list for a Resource Access bundle, as
 * defined by spec §4.4:
 *
 *     default_recipients = {org members} ∪ ({runner} if !org-admin else ∅)
 *
 * Phase 2 stub: there is no `runners` table yet, so the response only
 * carries org members. The `:key` segment is accepted for API
 * cohesion + future per-key overrides, but does NOT influence the
 * computation in phase 2 — the default list is the same for every key
 * of a resource.
 *
 * Auth: relies on the user's Supabase session (cookies). RLS gates the
 * lookup — a non-member of the resource's org gets a 404, the same
 * response as if the resource id were unknown. No service-role here.
 */

import { type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { defaultRecipients, type PubKeyEntry } from '@crm/core/crypto';

import { createSupabaseServerClient } from '@/lib/supabase/server';

type ResourceRow = {
  id: string;
  organization_id: string;
  is_admin: boolean;
};
type MemberRow = {
  organization_id: string;
  user_id: string;
};
type KeyRow = {
  user_id: string;
  public_key: string | Uint8Array;
  fingerprint: string;
};

// Tiny schema slice — enough to type the chained calls in this handler.
// Re-introducing the full generated `Database` type lives in a separate
// task; here we only need the rows we read.
interface Schema {
  public: {
    Tables: {
      resources: {
        Row: ResourceRow;
        Insert: Partial<ResourceRow>;
        Update: Partial<ResourceRow>;
        Relationships: [];
      };
      org_members: {
        Row: MemberRow;
        Insert: Partial<MemberRow>;
        Update: Partial<MemberRow>;
        Relationships: [];
      };
      user_crypto_keys: {
        Row: KeyRow;
        Insert: Partial<KeyRow>;
        Update: Partial<KeyRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

interface RecipientResponseEntry {
  readonly user_id?: string;
  readonly public_key: string;
  readonly fingerprint: string;
}

interface RouteContext {
  readonly params: Promise<{ readonly rId: string; readonly key: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { rId } = await context.params;

  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseClient<Schema>;

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) {
    return jsonNoStore({ error: 'unauthorized' }, 401);
  }

  // RLS resources_select_member already filters by org membership; a
  // non-member sees 0 rows and we return 404 without distinguishing
  // "not found" from "not authorized" (safer surface).
  const { data: resource } = await supabase
    .from('resources')
    .select('*')
    .eq('id', rId)
    .maybeSingle();
  if (!resource) {
    return jsonNoStore({ error: 'not_found' }, 404);
  }

  const { data: members, error: membersErr } = await supabase
    .from('org_members')
    .select('*')
    .eq('organization_id', resource.organization_id);
  if (membersErr) {
    return jsonNoStore({ error: 'internal' }, 500);
  }

  const memberIds = (members ?? []).map((m) => m.user_id);

  // user_crypto_keys_select_org_peer policy lets us read peers' pubkeys.
  // A member who has not yet generated a keypair has no row here — we
  // exclude them: without a public key they cannot be a recipient.
  let keyRows: ReadonlyArray<KeyRow> = [];
  if (memberIds.length > 0) {
    const { data, error: keysErr } = await supabase
      .from('user_crypto_keys')
      .select('*')
      .in('user_id', memberIds);
    if (keysErr) {
      return jsonNoStore({ error: 'internal' }, 500);
    }
    keyRows = data ?? [];
  }

  const orgMembers: PubKeyEntry[] = [];
  const userIdByFingerprint = new Map<string, string>();
  for (const row of keyRows) {
    orgMembers.push({
      publicKey: byteaToBytes(row.public_key),
      fingerprint: row.fingerprint,
    });
    userIdByFingerprint.set(row.fingerprint, row.user_id);
  }

  // TODO(phase-5): include runner pubkey when runner is registered for the org.
  const runner: PubKeyEntry | undefined = undefined;
  const isOrgAdminResource = resource.is_admin === true;

  const defaults = defaultRecipients({ orgMembers, runner, isOrgAdminResource });

  const body: RecipientResponseEntry[] = defaults.map((entry) => {
    const userId = userIdByFingerprint.get(entry.fingerprint);
    const out: RecipientResponseEntry = {
      public_key: bytesToBase64(entry.publicKey),
      fingerprint: entry.fingerprint,
    };
    return userId ? { ...out, user_id: userId } : out;
  });

  return jsonNoStore({ defaults: body }, 200);
}

function jsonNoStore(payload: unknown, status: number): NextResponse {
  const res = NextResponse.json(payload, { status });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/**
 * Decode a bytea value as returned by @supabase/supabase-js. PostgREST
 * serialises bytea as the Postgres hex escape format `\\x<hex>`; some
 * builds surface it directly as a Uint8Array/Buffer instead.
 */
function byteaToBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === 'string' && value.startsWith('\\x')) {
    const hex = value.slice(2);
    if (hex.length % 2 !== 0) {
      throw new Error('Invalid bytea hex length');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) {
        throw new Error('Invalid bytea hex digit');
      }
      out[i] = byte;
    }
    return out;
  }
  throw new Error('Unexpected bytea encoding');
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
