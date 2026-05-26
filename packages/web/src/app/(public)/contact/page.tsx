import type { Metadata } from 'next';
import { ProseHeader, ProseWrap } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Contact — Vaubaan',
  description: 'How to reach Vaubaan for sales, support, security, privacy, and press.',
};

interface Channel {
  label: string;
  email: string;
  hint: string;
}

const channels: Channel[] = [
  {
    label: 'General & sales',
    email: 'hello@vaubaan.com',
    hint: 'Demo requests, partnership questions, pricing — we reply within one business day.',
  },
  {
    label: 'Support',
    email: 'support@vaubaan.com',
    hint: 'Account, billing or product issues. Include your organization slug and the request id from the audit log.',
  },
  {
    label: 'Security',
    email: 'security@vaubaan.com',
    hint: 'Vulnerability reports and security questions. PGP key available on request.',
  },
  {
    label: 'Privacy',
    email: 'privacy@vaubaan.com',
    hint: 'GDPR requests, DPA signature, data subject access.',
  },
  {
    label: 'Press',
    email: 'press@vaubaan.com',
    hint: 'Media kit, interviews, brand usage approvals.',
  },
];

export default function ContactPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Help"
        title="Contact"
        lead="The right inbox depending on what you need."
      />
      <div style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
        {channels.map((c) => (
          <div
            key={c.email}
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-4)',
              background: 'var(--surface-raised)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-1)',
              }}
            >
              <strong>{c.label}</strong>
              <a href={`mailto:${c.email}`}>{c.email}</a>
            </div>
            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 'var(--text-sm)' }}>
              {c.hint}
            </p>
          </div>
        ))}
      </div>
      <h2 style={{ marginTop: 'var(--space-10)' }}>Office</h2>
      <p>
        Vaubaan
        <br />
        Paris, France
      </p>
    </ProseWrap>
  );
}
