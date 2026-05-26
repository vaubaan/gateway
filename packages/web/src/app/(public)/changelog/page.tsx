import type { Metadata } from 'next';
import { ProseHeader, ProseWrap } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Changelog — Vaubaan',
  description: 'What is new in the Vaubaan MCP gateway.',
};

interface Entry {
  date: string;
  title: string;
  items: string[];
}

const entries: Entry[] = [
  {
    date: '2026-05-26',
    title: 'Light mode default, integration kit',
    items: [
      'Light theme is now the default for the dashboard and the public site.',
      'New left sidebar replaces the top bar across the authenticated app — Supabase-style nav with org switcher.',
      'Publish privacy policy, terms of service, security overview, DPA, subprocessors and brand pages.',
    ],
  },
  {
    date: '2026-05-22',
    title: 'GitHub provider GA',
    items: [
      '17 GitHub tools synthesized via Octokit, callable through the gateway.',
      'GitHub App install flow with state cookie and JIT installation tokens (RS256 JWT, 1h lifetime).',
      'Builtin roles: github:reader, github:developer.',
    ],
  },
  {
    date: '2026-05-15',
    title: 'Policy engine v1',
    items: [
      'Default-deny semantics for every tool / resource combination.',
      'Composable roles attached to bots, with deny-list overrides for dangerous tools.',
      'Audit log appends one row per call with policy decision and reason.',
    ],
  },
];

export default function ChangelogPage() {
  return (
    <ProseWrap>
      <ProseHeader eyebrow="Updates" title="Changelog" lead="The product, ordered by ship date." />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-8)',
          marginTop: 'var(--space-6)',
        }}
      >
        {entries.map((e) => (
          <article key={e.date}>
            <header style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-subtle)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {e.date}
              </span>
              <h2 style={{ margin: 0, fontSize: 'var(--text-md)' }}>{e.title}</h2>
            </header>
            <ul style={{ marginTop: 'var(--space-3)' }}>
              {e.items.map((it, idx) => (
                <li key={idx}>{it}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </ProseWrap>
  );
}
