/**
 * Programmatic AccessToken mint — spin up an ephemeral MCP credential
 * without a user session.
 *
 *   POST /api/v1/mgmt/tokens
 *     Authorization: Bearer vbn_mgmt_…
 *     body: { projectSlug, capabilities, name?, ttlHours? }
 *
 *   returns 201 { access_token, api_key }
 *
 * Behaviour
 *   - Auth via `Authorization: Bearer vbn_mgmt_…` (ManagementKey, org-scoped).
 *   - Validates that `projectSlug` resolves to a project of the bound org.
 *   - Parses every `capabilities[]` notation string (provider:plane/level:action@env)
 *     into a (provider, plane, level, action, env?) tuple — rejects malformed
 *     input with 400.
 *   - Mints a fresh AccessToken with `status='active'`, `expires_at = now + ttlHours`
 *     (default 24h, hard-capped at 168h = 7d).
 *   - Returns the `api_key` (visible **once** — argon2id at-rest).
 *
 * The gateway enforces `expires_at` at the hot-path.
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.1, §8 (mgmt endpoints).
 * ADR  : docs/decisions/programmatic-access-token-minting.md.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { type Capability, generateApiKey, hashApiKey, parseCapability } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24 * 7;

const BodySchema = z.object({
  projectSlug: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  name: z
    .string()
    .regex(/^[a-z0-9](-?[a-z0-9])*$/)
    .optional(),
  ttlHours: z.number().int().positive().max(MAX_TTL_HOURS).optional(),
});

function randomSuffix(): string {
  // 8 lowercase alphanum chars — sufficient to keep `name` uniqueness over a project.
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

export async function POST(req: NextRequest) {
  const guard = await requireManagementKey(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  // Parse every capability shorthand into its stored tuple form.
  let capabilities: Capability[];
  try {
    capabilities = body.capabilities.map((s) => {
      try {
        return parseCapability(s);
      } catch (e) {
        throw new Error(`invalid capability '${s}': ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid capability' },
      { status: 400 },
    );
  }

  const svc = getSupabaseServiceClient();

  // Resolve project (must live in the bound org).
  const { data: project } = await svc
    .from('projects')
    .select('id, slug')
    .eq('organization_id', guard.orgId)
    .eq('slug', body.projectSlug)
    .maybeSingle<{ id: string; slug: string }>();
  if (!project) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  const ttlHours = body.ttlHours ?? DEFAULT_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  const tokenName = body.name ?? `mgmt-${randomSuffix()}`;
  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);

  const { data: inserted, error: insertErr } = await svc
    .from('access_tokens')
    .insert({
      project_id: project.id,
      name: tokenName,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      expires_at: expiresAt,
      capabilities,
      // created_by stays null — the caller is not an auth.users row.
    })
    .select('id, name, project_id, api_key_prefix, status, expires_at, created_at')
    .single<{
      id: string;
      name: string;
      project_id: string;
      api_key_prefix: string;
      status: string;
      expires_at: string;
      created_at: string;
    }>();
  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'failed to insert access token' },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { access_token: inserted, api_key: apiKey, expires_at: expiresAt },
    { status: 201 },
  );
}
