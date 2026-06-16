/**
 * Unified token-mint — every caller mints a child token here.
 *
 *   POST /api/v1/tokens/mint
 *     Authorization: Bearer vbn_live_…
 *     body: {
 *       name, accepted_risks[], denied_risks?,
 *       scope: 'org' | 'project',
 *       projectId?, projectSlug?,
 *       bindings?: ProjectBinding[],   // for the preview computation
 *       context?,
 *       ttlSeconds?, ttlHours?,
 *       singleUse?,
 *     }
 *
 *   Responses
 *   - 201 { token, api_key, expires_at, accepted_risks } when preview is OK.
 *   - 403 { error, not_acceptable, not_inherited, risks } when at least one
 *         risk violates `acceptable_in_envs` or the parent-subset rule.
 *   - 400 schema/validation error.
 *
 * Spec : docs/decisions/unified-gates-drop-confirm.md §D5.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireToken } from '@/lib/auth/require-token';
import {
  isCarteBlancheParent,
  mintChildToken,
  MintInvariantError,
  type MintParent,
} from '@/lib/mint/child-mint';
import { computeMintPreview } from '@/lib/mint/preview';
import { TOKEN_NAME_REGEX } from '@/lib/mint/token-name';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24 * 7;
const MAX_TTL_SECONDS = 3600;

const BindingSchema = z.object({
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash']),
  resource_ref: z.string().min(1),
  env: z.string().min(1).optional().nullable(),
});

const BodySchema = z
  .object({
    name: z.string().regex(TOKEN_NAME_REGEX).optional(),
    scope: z.enum(['org', 'project']),
    projectId: z.string().uuid().optional(),
    projectSlug: z.string().min(1).optional(),
    ttlHours: z.number().int().positive().max(MAX_TTL_HOURS).optional(),
    ttlSeconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
    singleUse: z.boolean().optional(),
    context: z.record(z.unknown()).optional(),
    bindings: z.array(BindingSchema).optional(),
    accepted_risks: z.array(z.string().min(1)),
    denied_risks: z.array(z.string().min(1)).optional(),
  })
  .refine((b) => b.ttlSeconds === undefined || b.singleUse === true, {
    message: '`ttlSeconds` requires `singleUse: true` (use `ttlHours` for session tokens).',
    path: ['singleUse'],
  });

function ttlExpiresAt(body: { ttlHours?: number; ttlSeconds?: number }): {
  expiresAt: string;
  ttlMs: number;
} {
  if (body.ttlSeconds !== undefined) {
    const ttlMs = body.ttlSeconds * 1000;
    return { expiresAt: new Date(Date.now() + ttlMs).toISOString(), ttlMs };
  }
  const h = body.ttlHours ?? DEFAULT_TTL_HOURS;
  const ttlMs = h * 3600 * 1000;
  return { expiresAt: new Date(Date.now() + ttlMs).toISOString(), ttlMs };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string | null;
  organization_id: string;
}

export async function POST(req: NextRequest) {
  // Parse the body first so the session-fallback can hint org context from
  // `projectId|projectSlug` (the UI ships no Bearer but is logged in).
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const svc = getSupabaseServiceClient();

  // Resolve the target project (if scope='project'). We look it up org-
  // agnostically first so the session-fallback can pick up the org id from
  // the project itself ; the org-membership check is done by the guard, and
  // an extra equality on `organization_id === guard.orgId` re-locks scope
  // below (defense-in-depth against project-id leak across orgs).
  let projectRow: ProjectRow | null = null;
  if (body.scope === 'project') {
    if (body.projectId) {
      const { data } = await svc
        .from('projects')
        .select('id, slug, name, organization_id')
        .eq('id', body.projectId)
        .maybeSingle<ProjectRow>();
      projectRow = data ?? null;
    } else if (body.projectSlug) {
      const { data } = await svc
        .from('projects')
        .select('id, slug, name, organization_id')
        .eq('slug', body.projectSlug)
        .maybeSingle<ProjectRow>();
      projectRow = data ?? null;
    } else {
      return NextResponse.json(
        { error: 'scope="project" requires projectId or projectSlug' },
        { status: 400 },
      );
    }
  }
  const projectOrgId = projectRow?.organization_id;

  const guard = await requireToken(req.headers.get('authorization'), {
    allowSessionFallback: projectOrgId ? { orgId: projectOrgId } : undefined,
  });
  if (!guard.ok) return guard.response;

  if (body.scope === 'project') {
    if (!projectRow || projectOrgId !== guard.orgId) {
      return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
    }
  }

  const { expiresAt, ttlMs } = ttlExpiresAt(body);
  const tokenName = body.name ?? `${body.scope}-${randomSuffix()}`;
  const singleUse = body.singleUse ?? false;

  // Compute the preview when bindings are provided. Org-scoped mints
  // without bindings skip this — the subset check is enforced by
  // mintChildToken's invariants regardless.
  // Carte-blanche parents (migrated mgmt-keys, dashboard root tokens) bypass
  // the inherited check : pass `null` so resolveRiskRow treats every risk as
  // implicitly held. The subset rule is bypassed in `mintChildToken` too via
  // `isCarteBlancheParent`.
  if (body.scope === 'project' && projectRow && body.bindings && body.bindings.length > 0) {
    const parentRisksForPreview = isCarteBlancheParent({
      id: guard.token.id,
      name: guard.token.name,
      organization_id: guard.token.organization_id,
      scope: guard.token.scope,
      project_id: guard.token.project_id,
      accepted_risks: guard.token.accepted_risks,
      denied_risks: guard.token.denied_risks,
      depth: guard.token.depth,
      delegation_chain: guard.token.delegation_chain,
      expires_at: guard.token.expires_at,
      created_at: guard.token.created_at,
      created_by: guard.token.created_by,
    })
      ? null
      : guard.token.accepted_risks;
    const preview = computeMintPreview(
      { bindings: body.bindings, accepted_risks: body.accepted_risks },
      parentRisksForPreview,
    );
    if (!preview.ok) {
      return NextResponse.json(
        {
          error: 'one or more requested risks are not acceptable or not inherited',
          not_acceptable: preview.not_acceptable,
          not_inherited: preview.not_inherited,
          risks: preview.risks,
        },
        { status: 403 },
      );
    }
  }

  // Direct mint.
  const parent: MintParent = {
    id: guard.token.id,
    name: guard.token.name,
    organization_id: guard.token.organization_id,
    scope: guard.token.scope,
    project_id: guard.token.project_id,
    accepted_risks: guard.token.accepted_risks,
    denied_risks: guard.token.denied_risks,
    depth: guard.token.depth,
    delegation_chain: guard.token.delegation_chain,
    expires_at: guard.token.expires_at,
    created_at: guard.token.created_at,
    created_by: guard.token.created_by,
  };
  try {
    const minted = await mintChildToken(svc, {
      parent,
      tokenName,
      scope: body.scope,
      projectId: projectRow?.id ?? null,
      ttlMs,
      accepted_risks: body.accepted_risks,
      denied_risks: body.denied_risks ?? parent.denied_risks,
      singleUse,
      context: body.context ?? null,
      createdBy: guard.token.created_by,
    });
    const { data: tokenRow } = await svc
      .from('tokens')
      .select(
        'id, name, scope, project_id, organization_id, api_key_prefix, status, expires_at, created_at, depth, delegation_chain',
      )
      .eq('id', minted.tokenId)
      .maybeSingle();
    return NextResponse.json(
      {
        token: tokenRow,
        api_key: minted.apiKey,
        expires_at: expiresAt,
        accepted_risks: body.accepted_risks,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof MintInvariantError) {
      return NextResponse.json({ error: e.message }, { status: e.httpStatus });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'failed to mint child token' },
      { status: 500 },
    );
  }
}
