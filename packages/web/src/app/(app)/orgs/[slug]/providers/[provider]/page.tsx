/**
 * Provider info — landing page.
 *
 * Route   : `/orgs/[slug]/providers/[provider]`.
 * Spec    : docs/spec/gateway-risk-model.md §1, §2, §4.
 *
 * Behaviour :
 *  - When the provider has exactly ONE plane (github, vercel, railway, bash) :
 *    server-redirects to `[provider]/[plane]` — there is no useful landing.
 *  - When the provider has MULTIPLE planes (supabase) : renders a small
 *    landing showing the provider header + one card per plane, each
 *    linking to its own `[plane]` sub-page. This way the user can pick
 *    the surface (db / storage / auth / functions) before diving into the
 *    detailed 5-section doc.
 *
 * The original single-page implementation lived here ; the 4 reusable
 * sections moved to `@/components/providers/ProviderInfoSections.tsx` and
 * `[plane]/page.tsx` consumes them with plane-filtered data.
 */

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import { getSupabaseServer } from '@/lib/supabase/server';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Code, Row } from '@/components/ui';
import {
  PROVIDER_INFO,
  isProviderSlug,
  type PlaneInfo,
  type ProviderInfo,
} from '@/components/providers/provider-info';

export const dynamic = 'force-dynamic';

export default async function ProviderInfoLandingPage({
  params,
}: {
  params: Promise<{ slug: string; provider: string }>;
}) {
  const { slug, provider } = await params;
  if (!isProviderSlug(provider)) notFound();
  const info = PROVIDER_INFO[provider];

  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle<{ id: string; name: string; slug: string }>();
  if (!org) notFound();

  // Single-plane provider → redirect straight to the plane page.
  if (info.planes.length === 1) {
    redirect(`/orgs/${org.slug}/providers/${info.slug}/${info.planes[0]!.slug}`);
  }

  // Multi-plane → render a small landing.
  return (
    <main>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 'var(--space-6)',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <div>
          <Row gap="var(--space-3)">
            <h1 style={{ margin: 0 }}>{info.label}</h1>
            <Badge tone={info.kind === 'host' ? 'info' : 'neutral'}>{info.kind}</Badge>
            <Badge tone="neutral">{info.planes.length} planes</Badge>
          </Row>
          <p
            style={{
              margin: 'var(--space-2) 0 0',
              color: 'var(--text-muted)',
              fontSize: 'var(--text-sm)',
            }}
          >
            {info.pitch}
          </p>
        </div>
        <Link href={`/orgs/${org.slug}/providers`} style={{ color: 'var(--text-muted)' }}>
          ← all providers
        </Link>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
          {info.label} exposes {info.planes.length} distinct planes. Pick a plane to see its
          data-model diagram, risk catalog and MCP tools.
        </p>
        <div
          style={{
            display: 'grid',
            gap: 'var(--space-3)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          }}
        >
          {info.planes.map((plane) => (
            <PlaneCard key={plane.slug} info={info} plane={plane} orgSlug={org.slug} />
          ))}
        </div>
      </div>
    </main>
  );
}

function PlaneCard({
  info,
  plane,
  orgSlug,
}: {
  info: ProviderInfo;
  plane: PlaneInfo;
  orgSlug: string;
}) {
  return (
    <Card>
      <CardHeader>
        <Row gap="var(--space-2)">
          <CardTitle>{plane.label}</CardTitle>
          <Code>{plane.slug}</Code>
        </Row>
      </CardHeader>
      <CardBody>
        <p
          style={{
            margin: '0 0 var(--space-3)',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {plane.pitch}
        </p>
        <Link
          href={`/orgs/${orgSlug}/providers/${info.slug}/${plane.slug}`}
          style={{ textDecoration: 'none' }}
        >
          <Button size="sm" variant="primary">
            Open plane →
          </Button>
        </Link>
      </CardBody>
    </Card>
  );
}
