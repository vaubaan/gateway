import type { Metadata } from 'next';
import Link from 'next/link';
import { ProseHeader, ProseWrap, Toc } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'For Agents — Vaubaan',
  description:
    'Technical reference for AI agents using Vaubaan: authentication, tool discovery, delegation, escalation, and best practices.',
};

export default function ForAgentsPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Agent reference"
        title="For agents"
        lead="You're an AI agent. This page explains what Vaubaan gives you, how to authenticate, how to delegate to sub-agents, and how to handle denials. Drop this in your context."
      />

      <Toc
        items={[
          { id: 'what-you-hold', label: '1. What you hold' },
          { id: 'connect', label: '2. How to connect' },
          { id: 'tool-discovery', label: '3. Tool discovery' },
          { id: 'when-denied', label: '4. When you are denied' },
          { id: 'delegate', label: '5. How to delegate' },
          { id: 'escalation', label: '6. Escalation' },
          { id: 'best-practices', label: '7. Best practices' },
          { id: 'risk-catalog', label: '8. Risk catalog reference' },
          { id: 'human-docs', label: '9. For your human operator' },
        ]}
      />

      <h2 id="what-you-hold">1. What you hold</h2>
      <p>
        You have a single API key: <code>vbn_live_&lt;prefix&gt;_&lt;secret&gt;</code>. This is your
        identity. It carries:
      </p>
      <ul>
        <li>
          <strong>
            <code>accepted_risks</code>
          </strong>{' '}
          — an explicit list of risk IDs you are authorized to trigger. Example:{' '}
          <code>
            [&quot;github.read-code&quot;, &quot;github.feature-branch-write&quot;,
            &quot;github.create-pr&quot;]
          </code>
          .
        </li>
        <li>
          <strong>
            <code>bindings</code>
          </strong>{' '}
          — the set of cloud resources you can reach (specific repos, Vercel projects, Supabase
          refs). You cannot access resources outside your bindings.
        </li>
        <li>
          <strong>
            <code>expires_at</code>
          </strong>{' '}
          — when this token stops working. Non-negotiable.
        </li>
        <li>
          <strong>
            <code>parent_id</code>
          </strong>{' '}
          — if set, this token was minted by another token. Your risks are a strict subset of your
          parent&rsquo;s. You cannot exceed them.
        </li>
      </ul>
      <p>
        You do <strong>not</strong> hold any cloud credentials (no GitHub PAT, no Vercel token, no
        Supabase service key). You never need to. Vaubaan mints upstream credentials just-in-time
        for each allowed call.
      </p>

      <h2 id="connect">2. How to connect</h2>
      <p>Point your MCP client at the Vaubaan endpoint with your token as Bearer authentication:</p>
      <pre>
        <code>
          {`{
  "mcpServers": {
    "vaubaan": {
      "url": "https://vaubaan.com/mcp",
      "headers": {
        "Authorization": "Bearer vbn_live_aBcDeFgH_..."
      }
    }
  }
}`}
        </code>
      </pre>
      <p>
        This configuration works with Claude Code (<code>.mcp.json</code>), Cursor, Continue, and
        any MCP-compatible client. You talk to one endpoint — Vaubaan routes to the correct
        provider.
      </p>

      <h2 id="tool-discovery">3. Tool discovery</h2>
      <p>
        When you connect, Vaubaan advertises only the tools whose risks fit your token&rsquo;s
        envelope. If your token accepts{' '}
        <code>[&quot;github.read-code&quot;, &quot;github.create-pr&quot;]</code>, you will see
        GitHub read tools and PR creation tools — but not merge, release, or workflow tools.
      </p>
      <p>
        This is the deny-by-default contract surfacing through tool discovery: you literally cannot
        see tools you&rsquo;re not authorized to use. This keeps your tool list focused and prevents
        you from wasting tokens attempting calls that would be denied.
      </p>

      <h2 id="when-denied">4. When you are denied</h2>
      <p>
        If you attempt a call that touches a risk outside your envelope, the gateway returns a
        structured 403:
      </p>
      <pre>
        <code>
          {`HTTP/1.1 403 Forbidden
{
  "error": "risk-not-accepted",
  "missing_risks": ["github.merge-protected"],
  "executed_slice": "github.repo[acme/website].branch[main].merge-into.W",
  "hint": "Re-mint a token with this risk accepted, or restrict the operation."
}`}
        </code>
      </pre>
      <p>
        The response is <strong>actionable</strong>. When you receive a 403, you have three options:
      </p>
      <ol>
        <li>
          <strong>Narrow your operation.</strong> If you were trying to merge to <code>main</code>,
          consider pushing to a feature branch instead (which requires{' '}
          <code>github.feature-branch-write</code>, a less privileged risk).
        </li>
        <li>
          <strong>Mint a wider child token</strong> — but only if{' '}
          <em>your current token already carries the missing risk</em>. You cannot escalate your own
          privileges.
        </li>
        <li>
          <strong>Escalate to your parent</strong> (see <a href="#escalation">§6</a>). If your token
          has a <code>context.escalation_channel</code>, POST there to ask your parent to mint a
          wider token for you.
        </li>
      </ol>

      <h2 id="delegate">5. How to delegate</h2>
      <p>
        You can mint child tokens for sub-agents by calling the mint endpoint with your own token as
        Bearer:
      </p>
      <pre>
        <code>
          {`POST /api/v1/tokens/mint
Authorization: Bearer vbn_live_aBcDeFgH_...
Content-Type: application/json

{
  "name": "one-shot-pr-bot",
  "accepted_risks": ["github.create-pr"],
  "expires_in_seconds": 3600,
  "single_use": true,
  "context": {
    "task": "Create PR for feature/login-page",
    "agent_id": "pr-bot-001"
  }
}`}
        </code>
      </pre>
      <p>
        The response contains the child&rsquo;s <code>api_key</code> (shown once). Hand it to your
        sub-agent. The child:
      </p>
      <ul>
        <li>
          <strong>Gets a strict subset of your risks.</strong> You cannot mint a child with risks
          you don&rsquo;t carry. The gateway enforces this — no exceptions.
        </li>
        <li>
          <strong>Expires no later than you do.</strong> If your TTL is 4 hours, the child&rsquo;s
          cannot exceed 4 hours.
        </li>
        <li>
          <strong>Is cascade-revoked when you are.</strong> If your token is revoked, every
          descendant is deleted.
        </li>
        <li>
          <strong>Inherits your bindings.</strong> The child sees the same resources you do — it
          cannot access resources outside your binding set.
        </li>
      </ul>
      <p>
        <strong>Depth limit:</strong> the delegation chain caps at 5 levels (human &rarr;
        orchestrator &rarr; coder &rarr; sub-task is plenty of room). Plan your delegation hierarchy
        accordingly.
      </p>

      <h3>When to delegate</h3>
      <ul>
        <li>
          <strong>Always</strong> mint a child for a sub-agent rather than sharing your own token.
          This gives you: narrower blast radius, independent revocation, and cleaner audit trails.
        </li>
        <li>
          <strong>Prefer single-use tokens</strong> for one-shot tasks (create a PR, run a
          migration, deploy a preview). The token auto-expires after one successful call.
        </li>
        <li>
          <strong>Prefer short TTLs.</strong> A 1-hour token for a coding task is better than an
          8-hour token &ldquo;just in case.&rdquo;
        </li>
      </ul>

      <h2 id="escalation">6. Escalation</h2>
      <p>
        When you need a risk you don&rsquo;t have, you can ask your parent token&rsquo;s owner (the
        agent or human who minted you) to grant it. This works through the{' '}
        <code>context.escalation_channel</code> — an HTTP endpoint your parent set when minting your
        token.
      </p>
      <pre>
        <code>
          {`POST {context.escalation_channel}
Content-Type: application/json

{
  "type": "escalation_request",
  "token_id": "your-token-id",
  "missing_risks": ["github.merge-protected"],
  "reason": "PR #42 is approved by 2 reviewers, ready to merge to main",
  "requested_ttl_seconds": 300
}`}
        </code>
      </pre>
      <p>
        The parent decides: mint a new child with the wider risk, or deny the escalation. Vaubaan
        stays out of this exchange — it&rsquo;s a direct child-to-parent conversation. The parent
        can:
      </p>
      <ul>
        <li>Mint a new token with the requested risk and hand it back.</li>
        <li>Deny the escalation with a reason.</li>
        <li>Ask for more context before deciding.</li>
      </ul>
      <p>
        If there is no <code>escalation_channel</code>, you cannot escalate programmatically. In
        that case, report the denied operation to your output and let the human operator decide.
      </p>

      <h2 id="best-practices">7. Best practices</h2>
      <ul>
        <li>
          <strong>Check your risks before acting.</strong> Call <code>GET /api/v1/tokens/me</code>{' '}
          to inspect your token&rsquo;s <code>accepted_risks</code> and <code>bindings</code>. Plan
          your actions within this envelope.
        </li>
        <li>
          <strong>Mint narrow, short-lived children.</strong> If you&rsquo;re orchestrating 3
          sub-tasks, mint 3 separate tokens — one per task, each with only the risks that specific
          task needs. This is cheaper to audit and limits blast radius.
        </li>
        <li>
          <strong>
            Use <code>context.task</code>
          </strong>{' '}
          when minting children. This string appears in the audit log and helps humans understand
          what each token was for.
        </li>
        <li>
          <strong>Handle 403s gracefully.</strong> A denied call is not an error — it&rsquo;s the
          system working correctly. Narrow your operation or escalate. Never retry a denied call
          with the same token.
        </li>
        <li>
          <strong>Don&rsquo;t hoard tokens.</strong> Mint a token, use it, let it expire. Tokens are
          cheap to create and the audit trail benefits from granularity.
        </li>
        <li>
          <strong>Log your delegation reasoning.</strong> When you mint a child, your{' '}
          <code>context.task</code> should explain why. When the human reviews the audit log, they
          should understand the delegation hierarchy without guessing.
        </li>
      </ul>

      <h2 id="risk-catalog">8. Risk catalog reference</h2>
      <p>
        Each provider has a catalog of ~10-15 risks. A risk is a business-intention statement like
        &ldquo;merge to a protected branch&rdquo; or &ldquo;deploy to production.&rdquo; Your
        token&rsquo;s <code>accepted_risks</code> is a subset of these.
      </p>
      <p>Risk IDs follow the pattern:</p>
      <pre>
        <code>{`<provider>.<risk-name>
# Examples:
github.read-code
github.feature-branch-write
github.merge-protected
vercel.deploy-preview
vercel.deploy-prod
supabase.bulk-row-write`}</code>
      </pre>
      <p>
        To see the full catalog for your token&rsquo;s providers, call{' '}
        <code>GET /api/v1/catalog</code>. The response includes every risk ID, its label, reason,
        and 6D severity vector (reversibility, blast radius, data sensitivity, cost, visibility,
        persistence).
      </p>
      <p>Key patterns across all providers:</p>
      <ul>
        <li>
          <strong>Reads are separate from writes.</strong> You can read code without being able to
          push. You can read deployments without being able to deploy.
        </li>
        <li>
          <strong>Environment matters.</strong> <code>vercel.deploy-preview</code> and{' '}
          <code>vercel.deploy-prod</code> are distinct risks. Staging and production are never
          conflated.
        </li>
        <li>
          <strong>Protected branches are explicit.</strong> Writing to <code>feature/*</code> and
          writing to <code>main</code> are different risks with different severity.
        </li>
        <li>
          <strong>Credential minting is a risk.</strong> If you can mint upstream tokens (e.g.
          GitHub installation tokens), that&rsquo;s an explicit risk because those tokens leave
          Vaubaan&rsquo;s gating perimeter.
        </li>
        <li>
          <strong>Every provider has a fallback.</strong>{' '}
          <code>&lt;provider&gt;.uncategorized-write</code> catches anything not explicitly
          categorized. It requires explicit acceptance.
        </li>
      </ul>

      <h2 id="human-docs">9. For your human operator</h2>
      <p>
        If your human operator needs to change your risk envelope, add bindings, or understand the
        system from the admin perspective, point them to the{' '}
        <Link href="/docs">operator documentation</Link>. That page covers connecting providers,
        binding resources, and minting tokens from the UI.
      </p>
      <p>
        For the raw, curl-friendly bootstrap reference (JSON-RPC shape, error codes, tool catalog),
        see{' '}
        <a href="/agent-bootstrap.md">
          <code>https://vaubaan.com/agent-bootstrap.md</code>
        </a>
        .
      </p>
    </ProseWrap>
  );
}
