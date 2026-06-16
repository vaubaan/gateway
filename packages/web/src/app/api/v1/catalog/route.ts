/**
 * Tool catalog discovery — `GET /api/v1/catalog`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7 (gateway surface).
 *
 * Lets a Bearer caller discover the full MCP tool surface and (for a
 * `vbn_live_*` token) the project's bindings + accepted risks. Risk
 * gating is enforced at `tools/call` time — the catalog itself is
 * purely informational.
 *
 * Two authentication modes :
 * - `Authorization: Bearer vbn_live_…` → catalog scoped to the token's
 *   project, with the token's accepted_risks echoed back.
 * - `Authorization: Bearer vbn_mgmt_…` → org-wide catalog ; no token
 *   info (the org-admin can mint anything modulo project policy).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@vaubaan/mcp-gateway';
import { parseApiKey, type McpToolDeclaration, type Provider } from '@vaubaan/shared';
import { githubAvailableTools } from '@vaubaan/providers-github';
import { vercelAvailableTools } from '@vaubaan/providers-vercel';
import { supabaseAvailableTools } from '@vaubaan/providers-supabase';
import { railwayAvailableTools } from '@vaubaan/providers-railway';
import { sshAvailableTools } from '@vaubaan/providers-ssh';
import { requireToken } from '@/lib/auth/require-token';
import { buildGateway } from '@/lib/gateway/build';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ProviderEntry {
  slug: Provider | 'ssh';
  displayName: string;
  tools: ReadonlyArray<McpToolDeclaration>;
}

const PROVIDERS: readonly ProviderEntry[] = [
  { slug: 'github', displayName: 'GitHub', tools: githubAvailableTools },
  { slug: 'vercel', displayName: 'Vercel', tools: vercelAvailableTools },
  { slug: 'supabase', displayName: 'Supabase', tools: supabaseAvailableTools },
  { slug: 'railway', displayName: 'Railway', tools: railwayAvailableTools },
  { slug: 'ssh', displayName: 'SSH', tools: sshAvailableTools },
];

interface BindingDescriptor {
  resourceRef: string;
  displayName: string | null;
  environment: string | null;
}

interface CatalogResponse {
  auth: {
    /** 'live' = project-scoped (project context echoed back) ; 'mgmt' =
     *  org-scoped root token (legacy label kept for SDK compat). */
    kind: 'live' | 'mgmt';
    organization: { id: string; slug: string; name?: string };
    project?: { id: string; slug: string };
    /** v4 — risk ids the token is allowed to touch (snapshot). */
    accepted_risks?: readonly string[];
    denied_risks?: readonly string[];
    bindings?: Record<string, BindingDescriptor[]>;
  };
  providers: Array<{
    slug: string;
    displayName: string;
    tools: McpToolDeclaration[];
  }>;
  mintHint: {
    endpoint: string;
    method: string;
    bodyShape: string;
    note: string;
  };
}

const MINT_HINT = {
  endpoint: '/api/v1/tokens/mint',
  method: 'POST',
  bodyShape:
    '{ "name": "<child-name>", "scope": "project", "projectId": "<id>", "bindings": [{ "provider": "github", "resource_ref": "owner/repo" }], "accepted_risks": ["<risk-id>", ...] }',
  note: 'Requires a Bearer vbn_live_* token. The mint may return 202 + approval_id when at least one accepted risk has effective_gate=confirm under the project policy.',
};

function providersPayload(): CatalogResponse['providers'] {
  return PROVIDERS.map((p) => ({
    slug: p.slug,
    displayName: p.displayName,
    tools: [...p.tools],
  }));
}

function groupBindings(
  bindings: ReadonlyArray<{
    provider: string;
    resource_ref: string;
    display_name: string | null;
    environment?: string | null;
  }>,
): Record<string, BindingDescriptor[]> {
  const out: Record<string, BindingDescriptor[]> = {};
  for (const b of bindings) {
    const arr = out[b.provider] ?? [];
    arr.push({
      resourceRef: b.resource_ref,
      displayName: b.display_name,
      environment: b.environment ?? null,
    });
    out[b.provider] = arr;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    return NextResponse.json(
      {
        error: 'missing or malformed Authorization header (expected `Bearer vbn_live_…`).',
      },
      { status: 401 },
    );
  }
  const raw = auth.slice('bearer '.length).trim();
  const parsed = parseApiKey(raw);
  if (!parsed) return NextResponse.json({ error: 'api_key format invalid.' }, { status: 401 });

  // Org-scoped tokens (parent_id IS NULL AND scope='org') get the org-wide
  // catalog ; project-scoped tokens get their project's view with the
  // accepted_risks echoed back.
  const guard = await requireToken(auth);
  if (!guard.ok) return guard.response;

  if (guard.token.scope === 'org') {
    const orgRow = await loadOrgById(guard.orgId);
    if (!orgRow) {
      return NextResponse.json({ error: 'organization not found.' }, { status: 404 });
    }
    const res: CatalogResponse = {
      auth: { kind: 'mgmt', organization: orgRow },
      providers: providersPayload(),
      mintHint: MINT_HINT,
    };
    return NextResponse.json(res);
  }

  try {
    const gateway = buildGateway({ clientIp: null, clientUserAgent: null });
    const ctx = await gateway.authenticate(auth);
    const res: CatalogResponse = {
      auth: {
        kind: 'live',
        organization: {
          id: ctx.organization.id,
          slug: ctx.organization.slug,
          name: ctx.organization.name,
        },
        project: { id: ctx.project.id, slug: ctx.project.slug },
        accepted_risks: ctx.accepted_risks,
        denied_risks: ctx.denied_risks,
        bindings: groupBindings(ctx.bindings),
      },
      providers: providersPayload(),
      mintHint: MINT_HINT,
    };
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.httpStatus });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `internal error: ${msg}` }, { status: 500 });
  }
}

async function loadOrgById(
  orgId: string,
): Promise<{ id: string; slug: string; name?: string } | null> {
  const svc = getSupabaseServiceClient();
  const { data } = await svc
    .from('organizations')
    .select('id, slug, name')
    .eq('id', orgId)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  return data ?? null;
}
