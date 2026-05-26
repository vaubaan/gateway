import type { Metadata } from 'next';
import { ProseHeader, ProseWrap, Toc } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Privacy policy — Vaubaan',
  description:
    'How Vaubaan collects, stores, and uses data when you connect GitHub, Vercel and Supabase through the MCP gateway.',
};

const UPDATED = '2026-05-26';

export default function PrivacyPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Legal"
        title="Privacy policy"
        lead="What Vaubaan stores, why we store it, and how to get it removed."
        updated={UPDATED}
      />
      <Toc
        items={[
          { id: 'who-we-are', label: 'Who we are' },
          { id: 'data-we-collect', label: 'Data we collect' },
          { id: 'how-we-use-data', label: 'How we use data' },
          { id: 'tokens-and-secrets', label: 'Tokens and secrets' },
          { id: 'audit-log', label: 'Audit log' },
          { id: 'sharing', label: 'Sharing & subprocessors' },
          { id: 'retention', label: 'Data retention' },
          { id: 'your-rights', label: 'Your rights' },
          { id: 'changes', label: 'Changes' },
          { id: 'contact', label: 'Contact' },
        ]}
      />

      <h2 id="who-we-are">1. Who we are</h2>
      <p>
        Vaubaan (&ldquo;we&rdquo;, &ldquo;us&rdquo;) operates the policy-enforcing MCP gateway
        available at <a href="https://vaubaan.com">vaubaan.com</a>. The service lets organizations
        connect their own GitHub, Vercel and Supabase accounts so that coding agents (Claude Code,
        Cursor and others) can perform tool calls under explicit, audited policies — without ever
        receiving a provider access token directly.
      </p>
      <p>
        The data controller for personal data processed through the service is the legal entity
        operating Vaubaan. For privacy questions, contact{' '}
        <a href="mailto:privacy@vaubaan.com">privacy@vaubaan.com</a>.
      </p>

      <h2 id="data-we-collect">2. Data we collect</h2>
      <p>We collect the minimum needed to operate the gateway.</p>
      <h3>Account data</h3>
      <ul>
        <li>Email address (for sign-in via Supabase Auth).</li>
        <li>Organization name and slug you create.</li>
        <li>Members you invite (email address and role).</li>
      </ul>
      <h3>Provider connection metadata</h3>
      <ul>
        <li>
          GitHub: installation ID, the organization or user that installed the GitHub App, and the
          list of repositories you bound to a project.
        </li>
        <li>
          Vercel: team ID and the projects you bound. Tokens you provide are stored encrypted at
          rest (see <a href="#tokens-and-secrets">§4</a>).
        </li>
        <li>
          Supabase: project_ref and team you bound. Tokens you provide are stored encrypted at rest.
        </li>
      </ul>
      <h3>Audit data</h3>
      <ul>
        <li>
          For every MCP call routed through the gateway: the calling bot id, the tool name, the
          resolved upstream resource, the policy decision (allow / deny), a hash of the arguments
          and a coarse timing. We do <em>not</em> store request bodies or upstream response bodies.
        </li>
      </ul>
      <h3>Technical data</h3>
      <ul>
        <li>
          HTTP request logs (IP, user agent, status code) retained for 30 days for abuse and
          operations.
        </li>
      </ul>

      <h2 id="how-we-use-data">3. How we use data</h2>
      <ul>
        <li>Run the service (authenticate users, mint upstream tokens, enforce policies).</li>
        <li>
          Produce the org-scoped audit log so admins can review what their agents did. Audit data is
          never shared across organizations.
        </li>
        <li>Detect abuse, debug incidents, and improve reliability.</li>
        <li>Send transactional emails (sign-in magic links, security notifications).</li>
      </ul>
      <p>
        We do <strong>not</strong> sell personal data and we do <strong>not</strong> use customer
        data to train AI models.
      </p>

      <h2 id="tokens-and-secrets">4. Tokens and secrets</h2>
      <p>Vaubaan never asks coding agents to paste provider tokens. The data flow is:</p>
      <ul>
        <li>
          For <strong>GitHub</strong>, we use the GitHub App install flow. We store the{' '}
          <code>installation_id</code> and use it to mint short-lived (1 hour) installation tokens
          on demand, then drop them from memory after the upstream call.
        </li>
        <li>
          For <strong>Vercel</strong> and <strong>Supabase</strong>, the org admin pastes a
          provider-issued PAT once through an authenticated channel. We encrypt it with AES-256-GCM
          using a key that lives in our infrastructure secrets manager. Decryption happens in memory
          only when minting a per-call upstream call.
        </li>
        <li>
          Agent-facing API keys (<code>vbn_live_…</code>) are returned to the org admin exactly
          once; we store only an HMAC for verification.
        </li>
      </ul>

      <h2 id="audit-log">5. Audit log</h2>
      <p>
        The audit log is the heart of the service and is visible to admins of the organization that
        owns the bot. Each entry records: timestamp, bot id, tool name, target resource, policy
        decision, deny reason (if any), and an opaque correlation id. Arguments and responses are
        not stored.
      </p>

      <h2 id="sharing">6. Sharing &amp; subprocessors</h2>
      <p>
        We share data only with subprocessors that help us run the service. See the current list at{' '}
        <a href="/subprocessors">/subprocessors</a>. We never sell data and never share with
        advertisers.
      </p>

      <h2 id="retention">7. Data retention</h2>
      <ul>
        <li>Account and organization data: retained while the account is active.</li>
        <li>Audit log: 90 days by default; configurable per-org up to 2 years.</li>
        <li>HTTP request logs: 30 days.</li>
        <li>
          On deletion, we purge all primary data within 30 days; encrypted backups age out within 35
          days.
        </li>
      </ul>

      <h2 id="your-rights">8. Your rights</h2>
      <p>
        Depending on your jurisdiction, you may have rights to access, correct, port or delete the
        personal data we hold about you. Email{' '}
        <a href="mailto:privacy@vaubaan.com">privacy@vaubaan.com</a> and we will respond within 30
        days.
      </p>

      <h2 id="changes">9. Changes</h2>
      <p>
        We will post material changes to this page and notify org admins by email at least 14 days
        before they take effect.
      </p>

      <h2 id="contact">10. Contact</h2>
      <p>
        Privacy: <a href="mailto:privacy@vaubaan.com">privacy@vaubaan.com</a>
        <br />
        Security: <a href="mailto:security@vaubaan.com">security@vaubaan.com</a>
        <br />
        General: <a href="mailto:hello@vaubaan.com">hello@vaubaan.com</a>
      </p>
    </ProseWrap>
  );
}
