import type { Metadata } from 'next';
import { ProseHeader, ProseWrap, Toc } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Security — Vaubaan',
  description:
    'How Vaubaan keeps your provider credentials and audit data safe. Token model, encryption, network isolation, incident response.',
};

const UPDATED = '2026-05-26';

export default function SecurityPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Trust"
        title="Security at Vaubaan"
        lead="The agent never sees the secret. Here's how we make that promise hold."
        updated={UPDATED}
      />
      <Toc
        items={[
          { id: 'principles', label: 'Principles' },
          { id: 'token-model', label: 'Token model' },
          { id: 'encryption', label: 'Encryption' },
          { id: 'isolation', label: 'Isolation' },
          { id: 'audit', label: 'Audit & observability' },
          { id: 'access', label: 'Access controls' },
          { id: 'incident', label: 'Incident response' },
          { id: 'disclosure', label: 'Responsible disclosure' },
        ]}
      />

      <h2 id="principles">1. Principles</h2>
      <ul>
        <li>
          <strong>No secret reaches the agent.</strong> Every upstream call is minted server-side by
          Vaubaan with a short-lived token. The agent only sees the result.
        </li>
        <li>
          <strong>Default deny.</strong> Every MCP call goes through the policy engine before it is
          forwarded upstream. New tools and new resources are denied until explicitly bound.
        </li>
        <li>
          <strong>Least privilege.</strong> Builtin roles (e.g. <code>github:developer</code>) scope
          writes to branches matching <code>feature/*</code>, <code>fix/*</code>,{' '}
          <code>claude/*</code>
          and forbid merges and deletes.
        </li>
        <li>
          <strong>Full audit.</strong> Every call — allow or deny — is logged with bot id, tool
          name, target, and policy decision.
        </li>
      </ul>

      <h2 id="token-model">2. Token model</h2>
      <p>
        <strong>GitHub.</strong> We use the GitHub App install flow. We store only the{' '}
        <code>installation_id</code>. For each authorized call we build a 9-minute JWT signed with
        the App private key (stored in our infrastructure secrets manager, never in DB), exchange it
        for a 1-hour installation token, use it for the upstream call, and drop it from memory.
      </p>
      <p>
        <strong>Vercel and Supabase.</strong> The org admin supplies a provider PAT through an
        authenticated channel. We encrypt it at rest with AES-256-GCM. The plaintext is held in
        memory only during the upstream call.
      </p>
      <p>
        <strong>Agent-facing keys.</strong> When an admin creates a Bot, the API key is shown
        exactly once. We store only an HMAC-SHA256 for verification. Lost keys must be rotated.
      </p>

      <h2 id="encryption">3. Encryption</h2>
      <ul>
        <li>All traffic uses TLS 1.2+ (HSTS enabled on the gateway).</li>
        <li>Data at rest in our managed Postgres is encrypted with AES-256 (provider-managed).</li>
        <li>
          Provider tokens are individually encrypted with AES-256-GCM and authenticated using a
          per-row nonce.
        </li>
        <li>Backups are encrypted and retained for 35 days max.</li>
      </ul>

      <h2 id="isolation">4. Isolation</h2>
      <ul>
        <li>
          Each organization is a separate tenant. Postgres Row-Level Security gates every cross-org
          read or write.
        </li>
        <li>
          The audit log is partitioned by organization and never queried across orgs in the same
          request.
        </li>
        <li>
          The gateway runs in stateless functions; no provider token is ever written to disk on the
          forwarder.
        </li>
      </ul>

      <h2 id="audit">5. Audit &amp; observability</h2>
      <p>
        Every MCP call appends one row to the org audit log: bot id, tool name, resolved upstream
        resource, policy decision, deny reason (if any), and timing. Admins can stream the log in
        the dashboard. Audit data is retained 90 days by default and is configurable per-org up to 2
        years.
      </p>

      <h2 id="access">6. Access controls</h2>
      <ul>
        <li>
          Org membership has two roles: <strong>admin</strong> (full control) and{' '}
          <strong>member</strong> (read-only view of audit and projects).
        </li>
        <li>Bot creation, provider connection, and role edits require admin.</li>
        <li>
          Internal access by Vaubaan staff to production is logged, scoped, and requires a
          documented ticket.
        </li>
      </ul>

      <h2 id="incident">7. Incident response</h2>
      <p>
        We will notify affected customers without undue delay (and at the latest within 72 hours
        where required by GDPR) of any security incident involving their data. Our incident-response
        runbook covers detection, containment, eradication, recovery and post-mortem.
      </p>

      <h2 id="disclosure">8. Responsible disclosure</h2>
      <p>
        Report a vulnerability to <a href="mailto:security@vaubaan.com">security@vaubaan.com</a>. We
        commit to acknowledging within 2 business days, providing a remediation timeline within 7
        days, and not pursuing legal action against good-faith researchers.
      </p>
    </ProseWrap>
  );
}
