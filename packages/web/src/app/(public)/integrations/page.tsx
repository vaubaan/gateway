import type { Metadata } from 'next';
import { ProseHeader, ProseWrap } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Integrations — Vaubaan',
  description: 'Providers supported by the Vaubaan MCP gateway and the tools each one exposes.',
};

interface Integration {
  slug: string;
  name: string;
  status: 'GA' | 'Beta' | 'Soon';
  short: string;
  tools: number;
  roles: string[];
  install: string;
}

const integrations: Integration[] = [
  {
    slug: 'github',
    name: 'GitHub',
    status: 'GA',
    short:
      'GitHub App install. JIT installation tokens minted per call. 17 tools: read, search, branch, PR, comment. Dangerous ops deny-listed by default.',
    tools: 17,
    roles: ['github:reader', 'github:developer'],
    install: 'GitHub App install via OAuth-style consent screen — no token paste.',
  },
  {
    slug: 'vercel',
    name: 'Vercel',
    status: 'Beta',
    short:
      'Team-scoped Personal Access Token, encrypted at rest. Project / deployment / domain / env-var tools, with per-environment write controls.',
    tools: 12,
    roles: ['vercel:viewer', 'vercel:deployer'],
    install: 'Org admin pastes a team-scoped PAT once. Stored AES-256-GCM encrypted.',
  },
  {
    slug: 'supabase',
    name: 'Supabase',
    status: 'Beta',
    short:
      'Management API PAT, encrypted at rest. Project / DB / Edge Function / Storage tools, with destructive operations gated by role.',
    tools: 14,
    roles: ['supabase:viewer', 'supabase:operator'],
    install: 'Org admin pastes a Mgmt PAT once. Stored AES-256-GCM encrypted.',
  },
];

const STATUS_TONE: Record<Integration['status'], string> = {
  GA: 'var(--accent-success-fg)',
  Beta: 'var(--accent-info-fg)',
  Soon: 'var(--accent-warning-fg)',
};

export default function IntegrationsPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Catalog"
        title="Integrations"
        lead="Every provider Vaubaan supports today, the tools it exposes, and the builtin roles you can attach to a bot."
      />

      <div style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-6)' }}>
        {integrations.map((i) => (
          <article
            key={i.slug}
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-5)',
              background: 'var(--surface-raised)',
            }}
          >
            <header
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-2)',
              }}
            >
              <h3 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{i.name}</h3>
              <span
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: STATUS_TONE[i.status],
                  fontWeight: 600,
                }}
              >
                {i.status}
              </span>
            </header>
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>{i.short}</p>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 'var(--space-3)',
                marginTop: 'var(--space-4)',
              }}
            >
              <div>
                <dt
                  style={{
                    color: 'var(--text-subtle)',
                    fontSize: 'var(--text-xs)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  Tools
                </dt>
                <dd style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--text-sm)' }}>
                  {i.tools}
                </dd>
              </div>
              <div>
                <dt
                  style={{
                    color: 'var(--text-subtle)',
                    fontSize: 'var(--text-xs)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  Builtin roles
                </dt>
                <dd style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--text-sm)' }}>
                  {i.roles.map((r) => (
                    <code key={r} style={{ marginRight: 'var(--space-1)' }}>
                      {r}
                    </code>
                  ))}
                </dd>
              </div>
              <div>
                <dt
                  style={{
                    color: 'var(--text-subtle)',
                    fontSize: 'var(--text-xs)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  Install
                </dt>
                <dd
                  style={{
                    margin: 'var(--space-1) 0 0',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {i.install}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>

      <h2>Missing a provider?</h2>
      <p>
        Email <a href="mailto:hello@vaubaan.com">hello@vaubaan.com</a> &mdash; we&rsquo;re actively
        adding integrations and prioritize requests with a concrete use case. The provider contract
        is documented in{' '}
        <a
          href="https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/spec/vaubaan-gateway.md"
          target="_blank"
          rel="noreferrer noopener"
        >
          our open spec
        </a>
        .
      </p>
    </ProseWrap>
  );
}
