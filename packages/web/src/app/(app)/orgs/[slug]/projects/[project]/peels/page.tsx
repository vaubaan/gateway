import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Badge, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import {
  ARCHETYPE_LABEL,
  PROVIDER_CATALOG,
  type LevelDescriptor,
  type PlaneDescriptor,
  type ProviderDescriptor,
} from '@/lib/capabilities/peel-catalog';

export const dynamic = 'force-dynamic';

interface BindingRow {
  provider: string;
  resource_ref: string;
  environment: string | null;
}

interface SshHostRow {
  host_slug: string;
}

export default async function PeelsPage({
  params,
}: {
  params: Promise<{ slug: string; project: string }>;
}) {
  const { slug, project } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!org) notFound();

  const { data: proj } = await supabase
    .from('projects')
    .select('id, slug, name')
    .eq('organization_id', org.id)
    .eq('slug', project)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!proj) notFound();

  const [{ data: bindings }, { data: sshHostsRows }] = await Promise.all([
    supabase
      .from('provider_bindings')
      .select('provider, resource_ref, environment')
      .eq('project_id', proj.id)
      .returns<BindingRow[]>(),
    supabase
      .from('ssh_bindings')
      .select('host_slug')
      .eq('project_id', proj.id)
      .returns<SshHostRow[]>(),
  ]);

  const usedProviders = new Set<string>([
    ...(bindings ?? []).map((b) => b.provider),
    ...((sshHostsRows ?? []).length > 0 ? ['ssh'] : []),
  ]);
  const visible = PROVIDER_CATALOG.filter((p) => usedProviders.has(p.slug));
  const others = PROVIDER_CATALOG.filter((p) => !usedProviders.has(p.slug));

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
          <h1 style={{ margin: 0 }}>Capability peels</h1>
          <Code>
            /{org.slug}/{proj.slug}/peels
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
            Reference for the concentric state model behind every capability. Each <em>plane</em> is
            a stack of <em>levels</em> (peels) ordered niv1 (the living data) → nivN (existence +
            creds). <strong>Outer governs inner</strong> — writing to an outer level affects the
            rules of every inner one (blast monotone). Pick R or W on a level, scope it to an env,
            you get a capability you can grant on a token.
          </p>
        </div>
        <Link
          href={`/orgs/${org.slug}/projects/${proj.slug}`}
          style={{ color: 'var(--text-muted)' }}
        >
          ← back
        </Link>
      </header>

      <Legend />

      <h2 style={{ marginTop: 'var(--space-6)', marginBottom: 'var(--space-3)' }}>
        Bound to this project
      </h2>
      {visible.length === 0 ? (
        <p style={{ color: 'var(--text-subtle)' }}>
          No providers bound yet. Bind a resource from the project page to see its peels.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          {visible.map((p) => (
            <ProviderPeels key={p.slug} provider={p} />
          ))}
        </div>
      )}

      {others.length > 0 && (
        <>
          <h2 style={{ marginTop: 'var(--space-6)', marginBottom: 'var(--space-3)' }}>
            Other supported providers
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Reference only — bind a resource of these to grant capabilities.
          </p>
          <div style={{ display: 'grid', gap: 'var(--space-4)', opacity: 0.8 }}>
            {others.map((p) => (
              <ProviderPeels key={p.slug} provider={p} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function Legend() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Legend</CardTitle>
      </CardHeader>
      <CardBody style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        <ul style={{ paddingLeft: 'var(--space-4)', margin: 0 }}>
          <li>
            <strong>niv</strong> — rank of the peel inside its plane. niv1 = innermost (the living
            data) ; nivN = outermost (existence + creds). Outer governs inner ; writing an outer
            level is strictly more dangerous than writing an inner one.
          </li>
          <li>
            <strong>archetype</strong> — descriptive label for cross-provider comparison (
            <em>content</em>, <em>structure</em>, <em>governance</em>, <em>access</em>). UI hint
            only ; the runtime contract is provider-local.
          </li>
          <li>
            <strong>env-scoped</strong> — operations on this level live on parallel instances (a
            branch, a Vercel target, a Supabase project). You qualify them with an <Code>@env</Code>
            . <strong>env-less</strong> levels have a single global instance (branch protection,
            install tokens, account-level config).
          </li>
          <li>
            On env-scoped levels, an <strong>env-less write</strong> is a{' '}
            <Badge tone="warning">fan-out</Badge> : it touches every env at once. Default policy
            treats it as the strictest covered env.
          </li>
        </ul>
      </CardBody>
    </Card>
  );
}

function ProviderPeels({ provider }: { provider: ProviderDescriptor }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {provider.displayName}{' '}
          <Code style={{ marginLeft: 'var(--space-2)' }}>{provider.slug}</Code>
        </CardTitle>
      </CardHeader>
      <CardBody>
        {provider.planes.map((plane) => (
          <PlaneRings key={plane.slug} provider={provider.slug} plane={plane} />
        ))}
      </CardBody>
    </Card>
  );
}

function PlaneRings({ provider, plane }: { provider: string; plane: PlaneDescriptor }) {
  const sorted = [...plane.levels].sort((a, b) => b.rank - a.rank); // outer first
  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div
        style={{
          marginBottom: 'var(--space-3)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
        }}
      >
        <strong>plane</strong>
        <Code>
          {provider}:{plane.slug}
        </Code>
        <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-sm)' }}>
          {plane.description}
        </span>
      </div>
      <Rings levels={sorted} />
      <EnvFooter plane={plane} />
    </div>
  );
}

/** Recursively renders nested borders : outer-most level wraps everything,
 *  niv1 is the deepest box. */
function Rings({ levels }: { levels: LevelDescriptor[] }) {
  if (levels.length === 0) return null;
  const [outer, ...rest] = levels;
  return <RingBox level={outer!}>{rest.length > 0 ? <Rings levels={rest} /> : null}</RingBox>;
}

const RING_PALETTE = ['#1f2330', '#222740', '#252b50', '#2a3160'];

function RingBox({ level, children }: { level: LevelDescriptor; children: React.ReactNode }) {
  const depthColor = RING_PALETTE[(level.rank - 1) % RING_PALETTE.length];
  return (
    <div
      style={{
        border: '1px solid var(--border-subtle)',
        background: depthColor,
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
          <span
            style={{
              color: 'var(--text-subtle)',
              fontSize: 12,
              fontFamily: 'var(--font-geist-mono)',
            }}
          >
            niv{level.rank}
          </span>
          <Code>{level.slug}</Code>
          <span style={{ color: 'var(--text-subtle)', fontSize: 11 }}>
            {ARCHETYPE_LABEL[level.archetype]}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <Pill tone="info" label="R" />
          <Pill tone="warning" label="W" />
          {level.envScoped ? (
            <Pill tone="neutral" label="@env" />
          ) : (
            <Pill tone="neutral" label="env-less" />
          )}
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0, lineHeight: 1.4 }}>
        {level.description}
      </p>
      {children && <div style={{ marginTop: 'var(--space-3)' }}>{children}</div>}
    </div>
  );
}

function Pill({ tone, label }: { tone: 'info' | 'warning' | 'neutral'; label: string }) {
  const colors: Record<typeof tone, { bg: string; fg: string }> = {
    info: { bg: 'var(--accent-info-bg)', fg: 'var(--accent-info-fg)' },
    warning: { bg: 'var(--accent-warning-bg)', fg: 'var(--accent-warning-fg)' },
    neutral: { bg: 'var(--surface-base)', fg: 'var(--text-muted)' },
  };
  return (
    <span
      style={{
        padding: '2px 8px',
        background: colors[tone].bg,
        color: colors[tone].fg,
        borderRadius: 4,
        fontSize: 11,
        fontFamily: 'var(--font-geist-mono)',
        fontWeight: 600,
      }}
    >
      {label}
    </span>
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
