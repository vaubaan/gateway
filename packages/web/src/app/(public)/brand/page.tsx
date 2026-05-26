import type { Metadata } from 'next';
import { ProseHeader, ProseWrap } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Brand assets — Vaubaan',
  description:
    'Download Vaubaan logo, wordmark and color tokens for press, partnerships and integrations.',
};

interface Asset {
  label: string;
  path: string;
  size: string;
  bg: 'light' | 'dark';
}

const assets: Asset[] = [
  { label: 'Mark — SVG', path: '/logo-vaubaan.svg', size: '256 × 256', bg: 'light' },
  { label: 'Mark — PNG', path: '/logo-vaubaan.png', size: '512 × 512', bg: 'light' },
];

export default function BrandPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Press"
        title="Brand assets"
        lead="Logos and color tokens for partner directories, OAuth marketplaces, and press. Please don't modify the marks."
      />

      <h2>Logo</h2>
      <p>
        Use the SVG whenever possible. Keep at least a half-mark of clear space on all sides. Do not
        stretch, recolor or apply effects to the mark.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 'var(--space-3)',
          marginTop: 'var(--space-4)',
        }}
      >
        {assets.map((a) => (
          <a
            key={a.path}
            href={a.path}
            download
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: 'var(--space-2)',
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--surface-raised)',
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <div
              style={{
                height: 100,
                display: 'grid',
                placeItems: 'center',
                background: a.bg === 'dark' ? 'var(--gray-1000)' : 'var(--gray-20)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {}
              <img src={a.path} alt={a.label} width={60} height={60} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 500 }}>{a.label}</span>
              <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>
                {a.size}
              </span>
            </div>
          </a>
        ))}
      </div>

      <h2>Wordmark</h2>
      <p>
        The wordmark is set in Geist Sans Semibold with -0.01em letter-spacing. Use sentence case:
        &ldquo;Vaubaan&rdquo;, not &ldquo;VAUBAAN&rdquo;.
      </p>

      <h2>Color</h2>
      <ul>
        <li>
          <strong>Ink (default text):</strong> <code>oklch(4% 0 0)</code> on light,{' '}
          <code>oklch(99% 0 0)</code> on dark.
        </li>
        <li>
          <strong>Surface (page background):</strong> <code>oklch(99% 0 0)</code> on light,{' '}
          <code>oklch(4% 0 0)</code> on dark.
        </li>
        <li>
          <strong>Accent (interactive):</strong> <code>oklch(58% 0.18 250)</code> — Geist blue.
        </li>
      </ul>

      <h2>Naming</h2>
      <p>
        Always spelled with two A&rsquo;s: <code>Vaubaan</code>. Pronounced &ldquo;voh-BAAN&rdquo;.
      </p>

      <h2>Need something else?</h2>
      <p>
        Email <a href="mailto:press@vaubaan.com">press@vaubaan.com</a> for a custom format
        (favicons, social cards, partner-directory PNGs).
      </p>
    </ProseWrap>
  );
}
