import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Badge, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import {
  PROVIDER_CATALOG,
  type LevelDescriptor,
  type PlaneDescriptor,
} from '@/lib/capabilities/ring-catalog';
import { providerPlaneTools, type ToolEntry } from '@/lib/capabilities/tool-catalog';
import { ProviderSwitcher } from './provider-switcher';

export const dynamic = 'force-dynamic';

function ringLabel(rank: number): string {
  return `ring ${rank}`;
}

export default async function ProviderRingsPage({
  params,
}: {
  params: Promise<{ slug: string; provider: string }>;
}) {
  const { slug, provider } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!org) notFound();

  const descriptor = PROVIDER_CATALOG.find((p) => p.slug === provider);
  if (!descriptor) notFound();

  return (
    <main>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 'var(--space-6)',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>{descriptor.displayName}</h1>
          <Code>
            /{org.slug}/providers/{descriptor.slug}
          </Code>
          <p
            style={{
              color: 'var(--text-muted)',
              marginTop: 'var(--space-2)',
              maxWidth: 760,
              fontSize: 'var(--text-sm)',
              lineHeight: 1.5,
            }}
          >
            What the gateway can grant for <strong>{descriptor.displayName}</strong> — the plane(s)
            it exposes, the concentric rings inside each plane, and the env vocabulary you can scope
            a capability to. <strong>ring 1</strong> is the outer wall (the living data),{' '}
            <strong>ring N</strong> is the keep (account / credentials / install tokens). Writing an
            inner ring forces every outer ring to obey (blast monotone).
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <ProviderSwitcher
            orgSlug={org.slug}
            current={descriptor.slug}
            options={PROVIDER_CATALOG.map((p) => ({ slug: p.slug, displayName: p.displayName }))}
          />
          <Link href={`/orgs/${org.slug}/providers`} style={{ color: 'var(--text-muted)' }}>
            ← all providers
          </Link>
        </div>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {descriptor.planes.map((plane) => (
          <Card key={plane.slug}>
            <CardHeader>
              <CardTitle>
                plane <Code style={{ marginLeft: 'var(--space-2)' }}>{plane.slug}</Code>
              </CardTitle>
            </CardHeader>
            <CardBody>
              <p
                style={{
                  margin: 0,
                  marginBottom: 'var(--space-3)',
                  color: 'var(--text-muted)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                {plane.description}
              </p>
              <PlaneRings provider={descriptor.slug} plane={plane} />
              <EnvFooter plane={plane} />
              <ToolsList provider={descriptor.slug} planeSlug={plane.slug} />
            </CardBody>
          </Card>
        ))}
      </div>
    </main>
  );
}

function PlaneRings({ provider, plane }: { provider: string; plane: PlaneDescriptor }) {
  // ring 1 outermost → ring N innermost (the keep).
  const sorted = [...plane.levels].sort((a, b) => a.rank - b.rank);
  return <Rings provider={provider} planeSlug={plane.slug} levels={sorted} />;
}

function Rings({
  provider,
  planeSlug,
  levels,
}: {
  provider: string;
  planeSlug: string;
  levels: LevelDescriptor[];
}) {
  if (levels.length === 0) return null;
  const [outer, ...rest] = levels;
  return (
    <RingBox provider={provider} planeSlug={planeSlug} level={outer!}>
      {rest.length > 0 ? <Rings provider={provider} planeSlug={planeSlug} levels={rest} /> : null}
    </RingBox>
  );
}

const RING_PALETTE = [
  { bg: '#2b3242', text: 'rgba(255,255,255,0.92)', muted: 'rgba(255,255,255,0.7)' },
  { bg: '#39354f', text: 'rgba(255,255,255,0.94)', muted: 'rgba(255,255,255,0.72)' },
  { bg: '#4a3050', text: 'rgba(255,255,255,0.95)', muted: 'rgba(255,255,255,0.74)' },
  { bg: '#5a2a44', text: 'rgba(255,255,255,0.97)', muted: 'rgba(255,255,255,0.78)' },
  { bg: '#6e2333', text: 'rgba(255,255,255,1)', muted: 'rgba(255,255,255,0.82)' },
];

function RingBox({
  provider,
  planeSlug,
  level,
  children,
}: {
  provider: string;
  planeSlug: string;
  level: LevelDescriptor;
  children: React.ReactNode;
}) {
  const palette = RING_PALETTE[Math.min(level.rank - 1, RING_PALETTE.length - 1)]!;
  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,0.12)',
        background: palette.bg,
        color: palette.text,
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3)',
        marginBottom: children ? 0 : 'var(--space-2)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-2)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
          <strong style={{ fontSize: 13, color: palette.text }}>{ringLabel(level.rank)}</strong>
          <Code>{level.slug}</Code>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <Code>
            {provider}:{planeSlug}/{level.slug}:read
          </Code>
          <Code>
            {provider}:{planeSlug}/{level.slug}:write
          </Code>
        </div>
      </div>
      <p style={{ color: palette.muted, fontSize: 13, margin: 0, lineHeight: 1.4 }}>
        {level.description}
      </p>
      {!level.envScoped && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          <Badge tone="neutral">env-less</Badge>
        </div>
      )}
      {children && <div style={{ marginTop: 'var(--space-3)' }}>{children}</div>}
    </div>
  );
}

function ToolsList({ provider, planeSlug }: { provider: string; planeSlug: string }) {
  const tools = providerPlaneTools(provider, planeSlug);
  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <div
        style={{
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--text-muted)',
          marginBottom: 'var(--space-2)',
        }}
      >
        MCP tools{tools.length > 0 ? ` · ${tools.length}` : ''}
      </div>
      {tools.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
          No MCP tool is wired on this plane yet.
        </p>
      ) : (
        <div
          role="table"
          style={{
            display: 'grid',
            // col 1 & 2 = max-content (tool name + capability slugs) ;
            // col 3 = minmax(0, 1fr) so the description cell can shrink
            // below its content width and get the ellipsis treatment.
            gridTemplateColumns: 'max-content max-content minmax(0, 1fr)',
            columnGap: 'var(--space-3)',
            rowGap: '4px',
            fontSize: 13,
            lineHeight: 1.5,
            alignItems: 'baseline',
          }}
        >
          {tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} planeSlug={planeSlug} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({ tool, planeSlug }: { tool: ToolEntry; planeSlug: string }) {
  const onPlane = tool.capabilities.filter((c) => c.plane === planeSlug);
  return (
    <>
      <div role="cell">
        <Code>{tool.name}</Code>
      </div>
      <div role="cell" style={{ display: 'flex', gap: 4 }}>
        {onPlane.map((cap) => (
          <Code key={`${cap.level}:${cap.action}`}>
            {cap.provider}:{cap.plane}/{cap.level}:{cap.action}
          </Code>
        ))}
      </div>
      <div
        role="cell"
        style={{
          color: 'var(--text-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={tool.description}
      >
        {tool.description}
      </div>
    </>
  );
}

function EnvFooter({ plane }: { plane: PlaneDescriptor }) {
  return (
    <div
      style={{
        marginTop: 'var(--space-3)',
        padding: 'var(--space-2) var(--space-3)',
        background: 'var(--surface-base)',
        border: '1px dashed var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        fontSize: 13,
      }}
    >
      <strong>env vocabulary</strong>
      <span style={{ color: 'var(--text-muted)', marginLeft: 'var(--space-2)' }}>
        {plane.envHint}
      </span>
      {plane.knownEnvs.length > 0 && (
        <div style={{ marginTop: 'var(--space-2)', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {plane.knownEnvs.map((env) => (
            <Code key={env}>@{env}</Code>
          ))}
        </div>
      )}
    </div>
  );
}
