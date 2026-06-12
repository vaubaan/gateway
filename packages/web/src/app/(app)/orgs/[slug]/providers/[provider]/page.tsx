import { Fragment } from 'react';
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
              <EnvFooter plane={plane} />
              <PlaneRings provider={descriptor.slug} plane={plane} />
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
  const tools = providerPlaneTools(provider, plane.slug);
  return <Rings provider={provider} plane={plane} levels={sorted} tools={tools} />;
}

function Rings({
  provider,
  plane,
  levels,
  tools,
}: {
  provider: string;
  plane: PlaneDescriptor;
  levels: LevelDescriptor[];
  tools: readonly ToolEntry[];
}) {
  if (levels.length === 0) return null;
  const [outer, ...rest] = levels;
  return (
    <RingBox provider={provider} plane={plane} level={outer!} tools={tools}>
      {rest.length > 0 ? (
        <Rings provider={provider} plane={plane} levels={rest} tools={tools} />
      ) : null}
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
  plane,
  level,
  tools,
  children,
}: {
  provider: string;
  plane: PlaneDescriptor;
  level: LevelDescriptor;
  tools: readonly ToolEntry[];
  children: React.ReactNode;
}) {
  const palette = RING_PALETTE[Math.min(level.rank - 1, RING_PALETTE.length - 1)]!;
  const toolsAtLevel = tools.filter((t) =>
    t.capabilities.some((c) => c.plane === plane.slug && c.level === level.slug),
  );
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
          <span style={{ fontSize: 12, color: palette.muted, letterSpacing: '0.04em' }}>
            {ringLabel(level.rank)}
          </span>
          <strong style={{ fontSize: 15, color: palette.text, letterSpacing: '0.01em' }}>
            {level.slug}
          </strong>
          <EnvChip plane={plane} envScoped={level.envScoped} />
        </div>
        <Code>
          {provider}:{plane.slug}/{level.slug}:
        </Code>
      </div>
      <p style={{ color: palette.muted, fontSize: 13, margin: 0, lineHeight: 1.4 }}>
        {level.description}
      </p>
      {toolsAtLevel.length > 0 && (
        <LevelToolsTable
          tools={toolsAtLevel}
          planeSlug={plane.slug}
          levelSlug={level.slug}
          mutedColor={palette.muted}
        />
      )}
      {children && <div style={{ marginTop: 'var(--space-3)' }}>{children}</div>}
    </div>
  );
}

function EnvChip({ plane, envScoped }: { plane: PlaneDescriptor; envScoped: boolean }) {
  if (!envScoped) return <Badge tone="neutral">env-less</Badge>;
  const envs = plane.knownEnvs;
  const label =
    envs.length === 0
      ? 'env-scoped'
      : envs.length <= 2
        ? `env: ${envs.join(', ')}`
        : `env: ${envs.slice(0, 2).join(', ')}, …`;
  return (
    <span title={plane.envHint}>
      <Badge tone="neutral">{label}</Badge>
    </span>
  );
}

function LevelToolsTable({
  tools,
  planeSlug,
  levelSlug,
  mutedColor,
}: {
  tools: readonly ToolEntry[];
  planeSlug: string;
  levelSlug: string;
  mutedColor: string;
}) {
  return (
    <div
      role="table"
      style={{
        marginTop: 'var(--space-3)',
        display: 'grid',
        // col 1 & 2 = max-content (tool name + R/W chips) ;
        // col 3 = minmax(0, 1fr) so the description can truncate with ellipsis.
        gridTemplateColumns: 'max-content max-content minmax(0, 1fr)',
        columnGap: 'var(--space-3)',
        rowGap: '4px',
        fontSize: 13,
        lineHeight: 1.5,
        alignItems: 'baseline',
      }}
    >
      {tools.map((tool) => {
        const actions = uniqueActionsAtLevel(tool, planeSlug, levelSlug);
        return (
          <Fragment key={tool.name}>
            <div role="cell">
              <Code>{tool.name}</Code>
            </div>
            <div role="cell" style={{ display: 'flex', gap: 4 }}>
              {actions.map((a) => (
                <Code key={a}>{a === 'read' ? 'R' : 'W'}</Code>
              ))}
            </div>
            <div
              role="cell"
              style={{
                color: mutedColor,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={tool.description}
            >
              {tool.description}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function uniqueActionsAtLevel(
  tool: ToolEntry,
  planeSlug: string,
  levelSlug: string,
): readonly ('read' | 'write')[] {
  const set = new Set<'read' | 'write'>();
  for (const cap of tool.capabilities) {
    if (cap.plane === planeSlug && cap.level === levelSlug) set.add(cap.action);
  }
  // Stable order : read before write.
  return (['read', 'write'] as const).filter((a) => set.has(a));
}

function EnvFooter({ plane }: { plane: PlaneDescriptor }) {
  return (
    <div
      style={{
        marginBottom: 'var(--space-3)',
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
