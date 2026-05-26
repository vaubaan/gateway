import type { Metadata } from 'next';
import Link from 'next/link';
import { ProseHeader, ProseWrap } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Support — Vaubaan',
  description: 'How to get help with Vaubaan: docs, audit log, and direct support channels.',
};

export default function SupportPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Help"
        title="Support"
        lead="The fastest path to a fix, in order of likelihood."
      />

      <h2>1. Read the audit log</h2>
      <p>
        Most &ldquo;why did my agent fail&rdquo; questions are answered there. Every denied call is
        logged with the exact policy and rule that fired. Open the dashboard and go to your
        organization &rarr; Audit log.
      </p>

      <h2>2. Read the docs</h2>
      <ul>
        <li>
          <a
            href="https://github.com/sbw-vaubaan/mcp-proxy#readme"
            target="_blank"
            rel="noreferrer noopener"
          >
            Overview, install, MCP client setup
          </a>
        </li>
        <li>
          <Link href="/security">Security architecture</Link>
        </li>
        <li>
          <Link href="/integrations">Integration catalog (providers and roles)</Link>
        </li>
      </ul>

      <h2>3. Email us</h2>
      <p>
        <a href="mailto:support@vaubaan.com">support@vaubaan.com</a> &mdash; include your
        organization slug and the correlation id from the audit log. We respond within one business
        day on the paid plan, best-effort on the free tier.
      </p>

      <h2>4. Security issues</h2>
      <p>
        Vulnerability reports go directly to{' '}
        <a href="mailto:security@vaubaan.com">security@vaubaan.com</a>. See our{' '}
        <Link href="/security#disclosure">responsible disclosure policy</Link>.
      </p>
    </ProseWrap>
  );
}
