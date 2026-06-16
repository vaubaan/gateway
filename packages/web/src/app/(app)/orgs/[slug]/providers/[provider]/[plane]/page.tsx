/**
 * Per-plane provider info page — the 5-section deep dive (header,
 * data-model, risks, tools, setup) scoped to ONE plane.
 *
 * Route   : `/orgs/[slug]/providers/[provider]/[plane]`.
 * Spec    : docs/spec/gateway-risk-model.md §1, §2, §4.
 *
 * For single-plane providers (github, vercel, railway, bash), the parent
 * `[provider]/page.tsx` redirects here with `plane === info.planes[0].slug`.
 * For Supabase (4 planes), users land on a chooser at the parent route and
 * navigate here — they can also switch planes via the sticky tab strip at
 * the top of this page.
 *
 * Plane scoping :
 *  - data-model diagram : `dataModelToMermaid(model, { planeSlug })`.
 *  - risk catalog       : `risksForPlane(entries, model, planeSlug)`.
 *  - MCP tools          : `toolsForPlane(info, planeSlug)`.
 *  - setup paragraph    : `plane.setup ?? info.setup`.
 */

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import type { RiskEntry } from '@vaubaan/shared';

import { getSupabaseServer } from '@/lib/supabase/server';
import { getCatalog } from '@/lib/risk-catalog/loader';
import { Badge, Button, Code, Row } from '@/components/ui';
import {
  PROVIDER_INFO,
  isProviderSlug,
  risksForPlane,
  toolsForPlane,
  type ProviderInfo,
} from '@/components/providers/provider-info';
import {
  DataModelCard,
  RiskCatalogCard,
  SetupCard,
  ToolsMappingCard,
} from '@/components/providers/ProviderInfoSections';

export const dynamic = 'force-dynamic';

const GITHUB_BLOB_BASE = 'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/';

/** Sort key for risks : deny > confirm > allow > (fallbacks last by id). */
const GATE_ORDER: Record<'allow' | 'confirm' | 'deny', number> = {
  deny: 0,
  confirm: 1,
  allow: 2,
};

export default async function ProviderPlanePage({
  params,
}: {
  params: Promise<{ slug: string; provider: string; plane: string }>;
}) {
  const { slug, provider, plane: planeSlug } = await params;

  if (!isProviderSlug(provider)) notFound();
  const info = PROVIDER_INFO[provider];
  const plane = info.planes.find((p) => p.slug === planeSlug);
  if (!plane) notFound();

  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle<{ id: string; name: string; slug: string }>();
  if (!org) notFound();

  const catalog = getCatalog(provider);
  const allEntries: RiskEntry[] = catalog ? catalog.entries.map((e) => e.entry) : [];
  const planeEntries = risksForPlane(allEntries, info.dataModel, plane.slug);

  // Sort entries by gate severity (deny first), then by id.
  const sortedEntries = [...planeEntries].sort((a, b) => {
    const gateDiff = GATE_ORDER[a.default_gate] - GATE_ORDER[b.default_gate];
    if (gateDiff !== 0) return gateDiff;
    return a.id.localeCompare(b.id);
  });

  const planeTools = toolsForPlane(info, plane.slug);
  const yamlGithubUrl = `${GITHUB_BLOB_BASE}${info.catalogPath}`;
  const handbookGithubUrl = `${GITHUB_BLOB_BASE}${info.handbook}`;
  const setupText = plane.setup ?? info.setup;

  return (
    <main>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 'var(--space-4)',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <div>
          <Row gap="var(--space-3)">
            <h1 style={{ margin: 0 }}>{info.label}</h1>
            <Badge tone={info.kind === 'host' ? 'info' : 'neutral'}>{info.kind}</Badge>
            <Badge tone="info">plane: {plane.slug}</Badge>
          </Row>
          <p
            style={{
              margin: 'var(--space-2) 0 0',
              color: 'var(--text-muted)',
              fontSize: 'var(--text-sm)',
            }}
          >
            {plane.pitch}
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 'var(--space-1)',
          }}
        >
          <Link href={`/orgs/${org.slug}/providers`} style={{ color: 'var(--text-muted)' }}>
            ← all providers
          </Link>
          {info.planes.length > 1 && (
            <Link
              href={`/orgs/${org.slug}/providers/${info.slug}`}
              style={{
                color: 'var(--text-muted)',
                fontSize: 'var(--text-xs)',
              }}
            >
              ← all {info.label} planes
            </Link>
          )}
        </div>
      </header>

      {info.planes.length > 1 && (
        <PlaneTabs info={info} currentPlaneSlug={plane.slug} orgSlug={org.slug} />
      )}

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <DataModelCard info={info} plane={plane} />
        <RiskCatalogCard
          info={info}
          entries={sortedEntries}
          catalogLoaded={catalog !== undefined}
        />
        <ToolsMappingCard info={info} tools={planeTools} entries={sortedEntries} />
        <SetupCard
          setupText={setupText}
          yamlGithubUrl={yamlGithubUrl}
          handbookGithubUrl={handbookGithubUrl}
        />
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PlaneTabs — sticky tab strip for switching planes within a provider.
// ─────────────────────────────────────────────────────────────────────────────

function PlaneTabs({
  info,
  currentPlaneSlug,
  orgSlug,
}: {
  info: ProviderInfo;
  currentPlaneSlug: string;
  orgSlug: string;
}) {
  return (
    <nav
      style={{
        display: 'flex',
        gap: 'var(--space-2)',
        position: 'sticky',
        top: 0,
        zIndex: 5,
        background: 'var(--surface-base)',
        padding: 'var(--space-2) 0',
        marginBottom: 'var(--space-3)',
        borderBottom: '1px solid var(--border-subtle)',
        flexWrap: 'wrap',
      }}
      aria-label="Plane navigation"
    >
      {info.planes.map((p) => {
        const active = p.slug === currentPlaneSlug;
        return (
          <Link
            key={p.slug}
            href={`/orgs/${orgSlug}/providers/${info.slug}/${p.slug}`}
            style={{ textDecoration: 'none' }}
            aria-current={active ? 'page' : undefined}
          >
            <Button size="sm" variant={active ? 'primary' : 'secondary'}>
              {p.label} <Code>{p.slug}</Code>
            </Button>
          </Link>
        );
      })}
    </nav>
  );
}
