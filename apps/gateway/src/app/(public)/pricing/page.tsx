import type { Metadata } from 'next';
import Link from 'next/link';
import { ProseHeader, ProseWrap } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Pricing — Vaubaan',
  description:
    'Vaubaan pricing for individuals, teams and the enterprise. Free during private beta.',
};

interface Tier {
  name: string;
  price: string;
  period?: string;
  highlight?: boolean;
  pitch: string;
  features: string[];
  cta: { label: string; href: string };
}

const tiers: Tier[] = [
  {
    name: 'Free',
    price: '€0',
    period: '/ month',
    pitch: 'For individual developers wiring up their first agent.',
    features: [
      '1 organization',
      'Up to 3 bots',
      '7-day audit retention',
      'Community support',
      'All builtin roles',
    ],
    cta: { label: 'Sign up', href: '/login' },
  },
  {
    name: 'Team',
    price: '€29',
    period: '/ seat / month',
    highlight: true,
    pitch: 'For teams running agents against shared cloud resources.',
    features: [
      'Unlimited bots and projects',
      '90-day audit retention',
      'SSO via Supabase Auth (Google, GitHub)',
      'Custom roles + per-env policies',
      'Email support · 1 business day',
    ],
    cta: { label: 'Contact sales', href: '/contact' },
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    pitch: 'For regulated industries with custom retention and audit needs.',
    features: [
      'Everything in Team',
      '2-year audit retention',
      'EU data residency',
      'Signed DPA + custom MSA',
      'Dedicated Slack channel',
    ],
    cta: { label: 'Talk to us', href: '/contact' },
  },
];

export default function PricingPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Pricing"
        title="Simple pricing that scales with audit volume."
        lead="Free during private beta. No credit card required."
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 'var(--space-4)',
          marginTop: 'var(--space-6)',
        }}
      >
        {tiers.map((t) => (
          <article
            key={t.name}
            style={{
              border: t.highlight
                ? '2px solid var(--text-foreground)'
                : '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-5)',
              background: 'var(--surface-raised)',
              position: 'relative',
            }}
          >
            {t.highlight && (
              <span
                style={{
                  position: 'absolute',
                  top: -10,
                  left: 'var(--space-4)',
                  background: 'var(--primary-bg)',
                  color: 'var(--primary-fg)',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  fontWeight: 600,
                }}
              >
                Most popular
              </span>
            )}
            <h3 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{t.name}</h3>
            <div
              style={{
                marginTop: 'var(--space-2)',
                display: 'flex',
                alignItems: 'baseline',
                gap: 4,
              }}
            >
              <span
                style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, letterSpacing: '-0.02em' }}
              >
                {t.price}
              </span>
              {t.period && (
                <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-sm)' }}>
                  {t.period}
                </span>
              )}
            </div>
            <p
              style={{
                color: 'var(--text-muted)',
                marginTop: 'var(--space-2)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {t.pitch}
            </p>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 'var(--space-4) 0',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {t.features.map((f) => (
                <li key={f} style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: 'var(--green-600)' }}>✓</span> {f}
                </li>
              ))}
            </ul>
            <Link
              href={t.cta.href}
              style={{
                display: 'inline-block',
                padding: '8px 16px',
                background: t.highlight ? 'var(--primary-bg)' : 'transparent',
                color: t.highlight ? 'var(--primary-fg)' : 'var(--text-foreground)',
                border: t.highlight ? 'none' : '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                textDecoration: 'none',
                fontSize: 'var(--text-sm)',
                fontWeight: 500,
              }}
            >
              {t.cta.label}
            </Link>
          </article>
        ))}
      </div>
      <h2 style={{ marginTop: 'var(--space-10)' }}>FAQ</h2>
      <h3>Is there a free tier?</h3>
      <p>
        Yes. The Free tier is permanent for individuals. During private beta, the Team tier is also
        free.
      </p>
      <h3>Do I need a credit card to start?</h3>
      <p>No. We collect billing only when an org upgrades from Free.</p>
      <h3>What counts as a &ldquo;bot&rdquo;?</h3>
      <p>
        A bot is a named API key that an agent uses. One Claude Code session per bot is the typical
        setup. You can have multiple bots per project (one per environment, one per role profile,
        …).
      </p>
    </ProseWrap>
  );
}
