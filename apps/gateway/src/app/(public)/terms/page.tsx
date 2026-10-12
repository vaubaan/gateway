import type { Metadata } from 'next';
import { ProseHeader, ProseWrap, Toc } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Terms of service — Vaubaan',
  description: 'Terms governing your use of the Vaubaan MCP gateway service.',
};

const UPDATED = '2026-05-26';

export default function TermsPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Legal"
        title="Terms of service"
        lead="The agreement between you and Vaubaan when you use the gateway."
        updated={UPDATED}
      />
      <Toc
        items={[
          { id: 'acceptance', label: 'Acceptance' },
          { id: 'account', label: 'Your account' },
          { id: 'acceptable-use', label: 'Acceptable use' },
          { id: 'providers', label: 'Connected providers' },
          { id: 'fees', label: 'Fees' },
          { id: 'ip', label: 'Intellectual property' },
          { id: 'warranty', label: 'Warranty disclaimer' },
          { id: 'liability', label: 'Liability' },
          { id: 'termination', label: 'Termination' },
          { id: 'law', label: 'Governing law' },
        ]}
      />

      <h2 id="acceptance">1. Acceptance</h2>
      <p>
        By creating an account or otherwise using vaubaan.com (the &ldquo;Service&rdquo;), you agree
        to these Terms of Service. If you are using the Service on behalf of an organization, you
        represent that you have authority to bind that organization.
      </p>

      <h2 id="account">2. Your account</h2>
      <ul>
        <li>You must provide accurate sign-up information and keep it up to date.</li>
        <li>You are responsible for the activity of users and bots under your organization.</li>
        <li>
          API keys (<code>vbn_live_…</code>) are confidential — treat them like passwords. We will
          rotate or revoke a key on request.
        </li>
      </ul>

      <h2 id="acceptable-use">3. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>
          Use the Service to attack, abuse or probe third-party systems without authorization.
        </li>
        <li>Reverse-engineer the Service except as permitted by law.</li>
        <li>Use the Service in violation of applicable export controls or sanctions.</li>
        <li>Send spam, malware, or otherwise compromise the integrity of the gateway.</li>
      </ul>

      <h2 id="providers">4. Connected providers</h2>
      <p>
        The Service is a gateway in front of providers (currently GitHub, Vercel and Supabase). You
        remain responsible for compliance with the terms of those providers and for the actions you
        authorize through Vaubaan. We are not a party to the relationship between you and a
        connected provider.
      </p>

      <h2 id="fees">5. Fees</h2>
      <p>
        Pricing is described on the <a href="/pricing">pricing page</a>. Fees are quoted in EUR
        unless stated otherwise, are billed in advance for the chosen plan, and are non-refundable
        except where required by law. Material price changes are notified at least 30 days in
        advance.
      </p>

      <h2 id="ip">6. Intellectual property</h2>
      <p>
        Vaubaan retains all rights in the Service. You retain all rights in the data and content you
        connect to the Service. You grant Vaubaan a limited license to process that data solely to
        provide the Service and as further described in the <a href="/privacy">privacy policy</a>.
      </p>

      <h2 id="warranty">7. Warranty disclaimer</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; without warranties of any kind, except as
        required by law. We do not warrant that the Service will be uninterrupted or error-free.
      </p>

      <h2 id="liability">8. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, neither party will be liable for indirect,
        incidental, special, consequential or punitive damages. Our aggregate liability for any
        claim arising out of these Terms is limited to the fees paid by you in the twelve months
        preceding the claim.
      </p>

      <h2 id="termination">9. Termination</h2>
      <p>
        You may terminate at any time from the dashboard. We may suspend or terminate accounts that
        materially breach these Terms, with notice where practicable. On termination, we will purge
        primary data within 30 days (see <a href="/privacy">privacy policy</a>).
      </p>

      <h2 id="law">10. Governing law</h2>
      <p>
        These Terms are governed by French law. Disputes are subject to the exclusive jurisdiction
        of the courts of Paris, France, except where mandatory consumer law applies.
      </p>
    </ProseWrap>
  );
}
