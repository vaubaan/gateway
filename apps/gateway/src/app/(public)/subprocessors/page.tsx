import type { Metadata } from 'next';
import { ProseHeader, ProseWrap } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Subprocessors — Vaubaan',
  description: 'The third-party services Vaubaan uses to deliver the gateway.',
};

const UPDATED = '2026-05-26';

interface Subprocessor {
  name: string;
  purpose: string;
  data: string;
  region: string;
  url: string;
}

const subprocessors: Subprocessor[] = [
  {
    name: 'Supabase',
    purpose:
      'Managed Postgres, authentication, and edge storage for organizational data and audit logs.',
    data: 'Account data, organization data, encrypted provider tokens, audit log.',
    region: 'EU (Frankfurt)',
    url: 'https://supabase.com',
  },
  {
    name: 'Vercel',
    purpose: 'Application hosting for the dashboard and the MCP gateway functions.',
    data: 'HTTP request logs, runtime telemetry. No customer payloads.',
    region: 'EU (Frankfurt) + global edge',
    url: 'https://vercel.com',
  },
  {
    name: 'Cloudflare',
    purpose: 'DNS, DDoS protection, WAF in front of vaubaan.com.',
    data: 'IP address, user agent, request metadata.',
    region: 'Global',
    url: 'https://cloudflare.com',
  },
  {
    name: 'Resend',
    purpose: 'Transactional email delivery (sign-in links, security notifications).',
    data: 'Email address, message metadata.',
    region: 'EU',
    url: 'https://resend.com',
  },
  {
    name: 'Stripe',
    purpose: 'Subscription billing and payment processing.',
    data: 'Billing contact, payment metadata (no card data passes through Vaubaan).',
    region: 'EU + global',
    url: 'https://stripe.com',
  },
];

export default function SubprocessorsPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Trust"
        title="Subprocessors"
        lead="The infrastructure providers Vaubaan relies on, what each one sees, and where they run."
        updated={UPDATED}
      />
      <p>
        We notify customers of new subprocessors at least 14 days before they go live. Subscribe to
        changes by emailing <a href="mailto:trust@vaubaan.com">trust@vaubaan.com</a>.
      </p>

      <div style={{ marginTop: 'var(--space-6)' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 'var(--text-sm)',
          }}
        >
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-subtle)' }}>
              <th
                style={{
                  padding: 'var(--space-3) var(--space-2)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                Subprocessor
              </th>
              <th
                style={{
                  padding: 'var(--space-3) var(--space-2)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                Purpose
              </th>
              <th
                style={{
                  padding: 'var(--space-3) var(--space-2)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                Data
              </th>
              <th
                style={{
                  padding: 'var(--space-3) var(--space-2)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                Region
              </th>
            </tr>
          </thead>
          <tbody>
            {subprocessors.map((s) => (
              <tr key={s.name} style={{ verticalAlign: 'top' }}>
                <td
                  style={{
                    padding: 'var(--space-3) var(--space-2)',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    {s.name}
                  </a>
                </td>
                <td
                  style={{
                    padding: 'var(--space-3) var(--space-2)',
                    borderBottom: '1px solid var(--border-subtle)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {s.purpose}
                </td>
                <td
                  style={{
                    padding: 'var(--space-3) var(--space-2)',
                    borderBottom: '1px solid var(--border-subtle)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {s.data}
                </td>
                <td
                  style={{
                    padding: 'var(--space-3) var(--space-2)',
                    borderBottom: '1px solid var(--border-subtle)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {s.region}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ProseWrap>
  );
}
