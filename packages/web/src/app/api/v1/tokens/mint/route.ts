/**
 * Unified token-mint — two modes :
 *
 *   POST /api/v1/tokens/mint
 *     Authorization: Bearer vbn_live_…   →  child mint (parent.id known,
 *                                            subset check applied)
 *     [session cookie, no Bearer]        →  root mint (parent_id=NULL,
 *                                            no subset check, user must
 *                                            be member of project's org)
 *
 *     body: {
 *       name?,
 *       projectId | projectSlug,
 *       accepted_risks[],
 *       denied_risks?,
 *       bindings?: ProjectBinding[],   // for preview computation
 *       context?,
 *       ttlSeconds?,
 *       ttlHours?,
 *       singleUse?,
 *     }
 *
 *   Responses
 *   - 201 { token, api_key, expires_at, accepted_risks } when preview is OK.
 *   - 403 { error, not_acceptable, not_inherited, risks } when at least one
 *         risk violates `acceptable_in_envs` (preview) or — in child mode
 *         only — the parent-subset rule.
 *   - 400 schema/validation error.
 *
 * Spec : docs/decisions/unified-gates-drop-confirm.md §D5,
 *        docs/decisions/unified-tokens-delegation-chain-and-escalation-channel.md
 *        (amended 2026-06-19).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireToken } from '@/lib/auth/require-token';
import {
  mintChildToken,
  mintRootToken,
  MintInvariantError,
  type MintParent,
} from '@/lib/mint/child-mint';
import { computeMintPreview } from '@/lib/mint/preview';
import { TOKEN_NAME_REGEX } from '@/lib/mint/token-name';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  .refine((b) => b.projectId !== undefined || b.projectSlug !== undefined, {
    message: 'projectId or projectSlug is required (all tokens are project-scoped).',
    path: ['projectId'],
  })
  .refine((b) => b.ttlSeconds === undefined || b.singleUse === true, {
    message: '`ttlSeconds` requires `singleUse: true` (use `ttlHours` for session tokens).',
    path: ['singleUse'],
  });

function ttlExpiresAt(body: { ttlHours?: number; ttlSeconds?: number }): {
  expiresAt: string | null;
  ttlMs: number | null;
} {
  if (body.ttlSeconds !== undefined) {
    const ttlMs = body.ttlSeconds * 1000;
    return { expiresAt: new Date(Date.now() + ttlMs).toISOString(), ttlMs };
  }
  if (body.ttlHours !== undefined) {
    const ttlMs = body.ttlHours * 3600 * 1000;
    return { expiresAt: new Date(Date.now() + ttlMs).toISOString(), ttlMs };
  }
  return { expiresAt: null, ttlMs: null };
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

  // Resolve the target project. We look it up org-agnostically first so
  // the session-fallback can hint org context from the project itself ;
  // the org-membership check is done by the guard, and an extra equality
  // on `organization_id === guard.orgId` re-locks scope below.
  let projectRow: ProjectRow | null = null;
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
  }
  if (!projectRow) {
    return NextResponse.json({ error: 'project not found' }, { status: 404 });
  }

  const guard = await requireToken(req.headers.get('authorization'), {
    allowSessionFallback: { orgId: projectRow.organization_id },
  });
  if (!guard.ok) return guard.response;

  if (projectRow.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  const { expiresAt, ttlMs } = ttlExpiresAt(body);
  const tokenName = body.name ?? `${projectRow.slug}-${randomSuffix()}`;
  const singleUse = body.singleUse ?? false;

  // Acceptability preview (catalog `acceptable_in_envs` guardrail). When
  // bindings are provided we run the preview ; subset check is only run
  // in child mode (mode='bearer') by passing the parent's accepted_risks
  // — in session/root mode the parent risks are null (no parent).
  const parentRisksForPreview = guard.mode === 'bearer' ? guard.token.accepted_risks : null;
  if (body.bindings && body.bindings.length > 0) {
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

  try {
    let minted;
    if (guard.mode === 'bearer') {
      const parent: MintParent = {
        id: guard.token.id,
        name: guard.token.name,
        organization_id: guard.token.organization_id,
        project_id: guard.token.project_id ?? projectRow.id,
        accepted_risks: guard.token.accepted_risks,
        denied_risks: guard.token.denied_risks,
        depth: guard.token.depth,
        delegation_chain: guard.token.delegation_chain,
        expires_at: guard.token.expires_at,
        created_at: guard.token.created_at,
        created_by: guard.token.created_by,
      };
      minted = await mintChildToken(svc, {
        parent,
        tokenName,
        projectId: projectRow.id,
        ttlMs,
        accepted_risks: body.accepted_risks,
        denied_risks: body.denied_risks ?? parent.denied_risks,
        singleUse,
        context: body.context ?? null,
        createdBy: guard.token.created_by,
      });
    } else {
      minted = await mintRootToken(svc, {
        organizationId: guard.orgId,
        projectId: projectRow.id,
        tokenName,
        ttlMs,
        accepted_risks: body.accepted_risks,
        denied_risks: body.denied_risks,
        singleUse,
        context: body.context ?? null,
        createdBy: guard.userId,
      });
    }
    const { data: tokenRow } = await svc
      .from('tokens')
      .select(
        'id, name, project_id, organization_id, api_key_prefix, status, expires_at, created_at, depth, delegation_chain',
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
      { error: e instanceof Error ? e.message : 'failed to mint token' },
      { status: 500 },
    );
  }
}
