/**
 * Tool catalog discovery — `GET /api/v1/catalog`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7 (gateway surface).
 *
 * Lets a Bearer caller discover the full MCP tool surface and, for a
 * `vbn_live_*` token, which tools are currently callable vs which require
 * a re-mint with additional capabilities.
 *
 * Two authentication modes :
 * - `Authorization: Bearer vbn_live_…` → catalog scoped to the token's
 *   project ; each tool carries `callable` + `missingCapabilities`. The
 *   `granted` capabilities of the token are echoed back so the caller can
 *   diff locally.
 * - `Authorization: Bearer vbn_mgmt_…` → org-wide catalog ; no `callable`
 *   info (the org-admin can mint anything modulo policy gates).
 *
 * The `callable` predicate matches `tools/list` filtering (same
 * `coversIgnoringEnv` from policy-engine), so the two surfaces stay in
 * lockstep.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@vaubaan/mcp-gateway';
import { formatCapability, parseApiKey, type Capability } from '@vaubaan/shared';
import { githubAvailableTools, githubToolCapabilities } from '@vaubaan/providers-github';
import { vercelAvailableTools, vercelToolCapabilities } from '@vaubaan/providers-vercel';
import { supabaseAvailableTools, supabaseToolCapabilities } from '@vaubaan/providers-supabase';
import { railwayAvailableTools, railwayToolCapabilities } from '@vaubaan/providers-railway';
import { sshAvailableTools, sshToolCapabilities } from '@vaubaan/providers-ssh';
import { requireManagementKey } from '@/lib/auth/require-management-key';
import { buildGateway } from '@/lib/gateway/build';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import {
  buildProviderCatalog,
  groupBindings,
  type BindingDescriptor,
  type ProviderCatalogEntry,
  type ProviderSource,
} from '@/lib/capabilities/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROVIDER_SOURCES: readonly ProviderSource[] = [
  {
    slug: 'github',
    displayName: 'GitHub',
    tools: githubAvailableTools,
    capabilitiesOf: githubToolCapabilities,
  },
  {
    slug: 'vercel',
    displayName: 'Vercel',
    tools: vercelAvailableTools,
    capabilitiesOf: vercelToolCapabilities,
  },
  {
    slug: 'supabase',
    displayName: 'Supabase',
    tools: supabaseAvailableTools,
    capabilitiesOf: supabaseToolCapabilities,
  },
  {
    slug: 'railway',
    displayName: 'Railway',
    tools: railwayAvailableTools,
    capabilitiesOf: railwayToolCapabilities,
  },
  {
    slug: 'ssh',
    displayName: 'SSH',
    tools: sshAvailableTools,
    capabilitiesOf: sshToolCapabilities,
  },
];

interface CatalogResponse {
  auth: {
    kind: 'live' | 'mgmt';
    organization: { id: string; slug: string; name?: string };
    project?: { id: string; slug: string };
    granted?: string[];
    /** Upstream resource refs the project is bound to, keyed by provider slug.
     *  Only emitted on `live` mode (a mgmt key isn't tied to one project).
     *  Each entry carries the `resourceRef` you need to pass at `tools/call`
     *  time (e.g. Vercel projectId, Supabase project_ref). */
    bindings?: Record<string, BindingDescriptor[]>;
  };
  providers: ProviderCatalogEntry[];
  /** Hint for the unlock flow when `callable: false`. UI/agents can render
   *  this verbatim instead of hardcoding the path. */
  mintHint: {
    endpoint: string;
    method: string;
    bodyShape: string;
    note: string;
  };
}

const MINT_HINT = {
  endpoint: '/api/v1/mgmt/tokens',
  method: 'POST',
  bodyShape: '{ "projectSlug": "<slug>", "capabilities": ["<cap>", ...] }',
  note: 'Requires a Bearer vbn_mgmt_* key. The mint may return 202 + approval_id when the requested capability hits a confirm-gated policy rule (default seed: all writes are gated).',
};

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    return NextResponse.json(
      {
        error:
          'missing or malformed Authorization header (expected `Bearer vbn_live_…` or `Bearer vbn_mgmt_…`).',
      },
      { status: 401 },
    );
  }
  const raw = auth.slice('bearer '.length).trim();
  const parsed = parseApiKey(raw);
  if (!parsed) return NextResponse.json({ error: 'api_key format invalid.' }, { status: 401 });

  if (parsed.kind === 'mgmt') {
    const guard = await requireManagementKey(auth);
    if (!guard.ok) return guard.response;
    const orgRow = await loadOrgById(guard.orgId);
    if (!orgRow) {
      return NextResponse.json({ error: 'organization not found.' }, { status: 404 });
    }
    const res: CatalogResponse = {
      auth: { kind: 'mgmt', organization: orgRow },
      providers: buildProviderCatalog(PROVIDER_SOURCES, null),
      mintHint: MINT_HINT,
    };
    return NextResponse.json(res);
  }

  try {
    const gateway = buildGateway({ clientIp: null, clientUserAgent: null });
    const ctx = await gateway.authenticate(auth);
    const granted: readonly Capability[] = ctx.capabilities;
    const res: CatalogResponse = {
      auth: {
        kind: 'live',
        organization: {
          id: ctx.organization.id,
          slug: ctx.organization.slug,
          name: ctx.organization.name,
        },
        project: { id: ctx.project.id, slug: ctx.project.slug },
        granted: granted.map(formatCapability),
        bindings: groupBindings(ctx.bindings),
      },
      providers: buildProviderCatalog(PROVIDER_SOURCES, granted),
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
