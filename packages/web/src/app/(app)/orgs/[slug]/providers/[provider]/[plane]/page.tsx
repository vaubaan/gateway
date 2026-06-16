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
 * navigate here — they can also jump between providers / planes via the
 * `<ProviderPlaneSwitcher>` dropdowns in the page header (no more "back to
 * …" links, the sidebar + browser back already cover that intent).
 *
 * Plane scoping :
 *  - data-model diagram : `dataModelToMermaid(model, { planeSlug })`.
 *  - risk catalog       : `risksForPlane(entries, model, planeSlug)`.
 *  - MCP tools          : `toolsForPlane(info, planeSlug)`.
 *  - setup paragraph    : `plane.setup ?? info.setup`.
 */

import { notFound, redirect } from 'next/navigation';

import type { RiskEntry } from '@vaubaan/shared';

import { getSupabaseServer } from '@/lib/supabase/server';
import { getCatalog } from '@/lib/risk-catalog/loader';
import { Badge, Row } from '@/components/ui';
import {
  PROVIDER_INFO,
  PROVIDER_SLUGS,
  isProviderSlug,
  risksForPlane,
  toolsForPlane,
} from '@/components/providers/provider-info';
import {
  DataModelCard,
  RiskCatalogCard,
  SetupCard,
  ToolsMappingCard,
} from '@/components/providers/ProviderInfoSections';
import { ProviderPlaneSwitcher } from '@/components/providers/ProviderNavDropdowns';

export const dynamic = 'force-dynamic';

const GITHUB_BLOB_BASE = 'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/';

/** Severity ordering derived from the 6D vector — irreversible /
 *  posture-shift / secret-write rank highest. Used to sort the catalog
 *  display so the heaviest risks bubble to the top. */
const PERSISTENCE_ORDER: Record<RiskEntry['vector']['persistence'], number> = {
  posture: 0,
  session: 1,
  stateless: 2,
};
const REVERSIBILITY_ORDER: Record<RiskEntry['vector']['reversibility'], number> = {
  irreversible: 0,
  costly: 1,
  reversible: 2,
};

function severityKey(entry: RiskEntry): number {
  return (
    PERSISTENCE_ORDER[entry.vector.persistence] * 10 +
    REVERSIBILITY_ORDER[entry.vector.reversibility]
  );
}

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

  // Sort entries by vector severity (heaviest first), then by id.
  const sortedEntries = [...planeEntries].sort((a, b) => {
    const sevDiff = severityKey(a) - severityKey(b);
    if (sevDiff !== 0) return sevDiff;
    return a.id.localeCompare(b.id);
  });

  const planeTools = toolsForPlane(info, plane.slug);
  const yamlGithubUrl = `${GITHUB_BLOB_BASE}${info.catalogPath}`;
  const handbookGithubUrl = `${GITHUB_BLOB_BASE}${info.handbook}`;
  const setupText = plane.setup ?? info.setup;

  return (
    <main className="vbn-page-wide">
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
        <ProviderPlaneSwitcher
          currentProviderSlug={info.slug}
          providers={PROVIDER_SLUGS.map((s) => ({ slug: s, label: PROVIDER_INFO[s].label }))}
          currentPlaneSlug={plane.slug}
          planes={info.planes.map((p) => ({ slug: p.slug, label: p.label }))}
          orgSlug={org.slug}
        />
      </header>

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
