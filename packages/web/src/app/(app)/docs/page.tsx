import type { Metadata } from 'next';
import Link from 'next/link';
import { ProseHeader, ProseWrap, Toc } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Documentation — Vaubaan',
  description:
    'One-page operator guide to Vaubaan: connect a cloud provider, bind resources, mint risk-scoped tokens, delegate to sub-agents, and audit every MCP call.',
};

export default function DocsPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Documentation"
        title="Operator guide"
        lead="Connect a provider, bind resources to a project, mint a risk-scoped token for your agent, let it delegate to sub-agents under the same envelope, and audit every call. One page, the whole product."
      />

      <Toc
        items={[
          { id: 'mental-model', label: '1. Mental model' },
          { id: 'how-it-works', label: '2. How it works (flow)' },
          { id: 'connect-provider', label: '3. Connect a provider' },
          { id: 'create-project', label: '4. Create a project' },
          { id: 'bind-resources', label: '5. Bind resources' },
          { id: 'tokens', label: '6. Tokens & delegation' },
          { id: 'risk-catalog', label: '7. Risk catalog' },
          { id: 'risks-policy', label: '8. Risks & policy' },
          { id: 'tool-calls', label: '9. Tool calls' },
          { id: 'audit', label: '10. Audit log' },
          { id: 'billing', label: '11. Billing & plans' },
          { id: 'security', label: '12. Security model' },
        ]}
      />

      <h2 id="mental-model">1. Mental model</h2>
      <p>
        Vaubaan is a multi-tenant MCP (Model Context Protocol) gateway. Your AI agents talk to one
        URL — <code>https://vaubaan.com/mcp</code> — authenticate with a single Bearer token, and we
        broker every call to GitHub, Vercel, Supabase, Railway, and bash/SSH under a{' '}
        <em>risk envelope</em> you accept up-front.
      </p>
      <p>The cardinal concepts:</p>
      <ul>
        <li>
          <strong>Organization</strong> — your tenant. Has members, providers, projects, an audit
          log. Most teams have one.
        </li>
        <li>
          <strong>Provider</strong> — GitHub, Vercel, Supabase, Railway, bash/SSH. Connected once
          per org, holds the long-lived upstream credentials (App install for GitHub, OAuth for
          Vercel, PAT for Supabase, host descriptors for bash/SSH).
        </li>
        <li>
          <strong>Project</strong> — a sub-scope inside the org (e.g. <code>website</code>,{' '}
          <code>backoffice</code>). Holds bindings, tokens, and per-project risk policy overrides.
        </li>
        <li>
          <strong>Binding</strong> — a project-scoped pointer to one concrete upstream resource: a
          GitHub repo, a Vercel project, a Supabase project, a Railway service, an SSH host.
        </li>
        <li>
          <strong>Token</strong> — unified credential of the form{' '}
          <code>vbn_live_&lt;prefix&gt;_&lt;secret&gt;</code>. Carries{' '}
          <code>accepted_risks: RiskId[]</code>, <code>bindings: ProviderBinding[]</code>, an
          optional <code>parent_id</code>, and a frozen <code>delegation_chain</code>. Every token —
          whether minted by a human in the UI or by another agent programmatically — looks the same
          on the wire.
        </li>
        <li>
          <strong>Risk</strong> — a business-intention sentence (&ldquo;merge to a protected
          branch&rdquo;, &ldquo;bulk-write rows on staging&rdquo;, &ldquo;deploy to prod&rdquo;)
          that you accept on behalf of the agent. Risks live in a per-provider catalog, named{' '}
          <code>&lt;provider&gt;[&lt;env&gt;].&lt;risk-name&gt;</code> (env qualifier optional when
          the risk is account-level, e.g. <code>github.mint-install-token</code>).
        </li>
        <li>
          <strong>Delegation</strong> — any token can mint a child token. The child&apos;s{' '}
          <code>accepted_risks</code> must be a strict subset of the parent&apos;s; its{' '}
          <code>expires_at</code> can&apos;t outlive the parent; max depth is 5.
        </li>
        <li>
          <strong>Escalation</strong> (out-of-band) — when a child gets a{' '}
          <code>403 risk-not-accepted</code>, it can POST to its parent via{' '}
          <code>context.escalation_channel</code> to ask for a wider token. Vaubaan stays out of
          this exchange — the parent decides, mints a new token, hands it back.
        </li>
      </ul>

      <h2 id="how-it-works">2. How it works (flow)</h2>
      <p>The day-one path is three steps:</p>
      <ol>
        <li>
          <strong>Human logs in</strong>, opens a project, clicks <em>New token</em> (route:{' '}
          <code>/orgs/[slug]/projects/[project]/tokens/new</code>).
        </li>
        <li>
          <strong>Mint UI shows a risk checklist</strong> — one row per applicable{' '}
          <code>RiskId</code>, qualified by binding (e.g.{' '}
          <code>supabase[staging].bulk-row-write</code>). Each row carries <code>acceptable</code>{' '}
          (the catalog allows it in this binding env) and <code>inherited</code> (your token already
          carries it). A row is mintable iff both are true ; otherwise the checkbox is disabled with
          a tooltip explaining why.
        </li>
        <li>
          <strong>You tick the risks you accept and submit.</strong> If every ticked row is
          acceptable + inherited, the mint succeeds and the <code>api_key</code> is shown once. If
          not, the call returns 403 with <code>not_acceptable</code> / <code>not_inherited</code>{' '}
          lists — untick those rows or request escalation through your token&apos;s parent.
        </li>
      </ol>
      <p>
        Once the agent has its <code>api_key</code>, it can <strong>mint sub-agents</strong>{' '}
        programmatically with a stricter envelope — e.g. a Story-Dev token covering &ldquo;coder +
        supabase[staging] + vercel.deploy-preview&rdquo; can spin up a one-shot coding-agent token
        narrowed down to just <code>github.feature-branch-write</code> for a single task. See{' '}
        <Link href="/docs/mgmt">/docs/mgmt</Link> for the programmatic API.
      </p>

      <h2 id="connect-provider">3. Connect a provider</h2>
      <p>
        Go to <em>Cloud providers</em> in the sidebar (<code>/orgs/[slug]/providers</code>) and
        click <strong>Connect</strong> on the provider you want.
      </p>
      <ul>
        <li>
          <strong>GitHub</strong> — installs the &ldquo;Vaubaan Gateway&rdquo; GitHub App on the
          target account. You pick which repos the App can see; that selection becomes the bindable
          resource set. The App mints short-lived installation tokens just-in-time; we never store a
          long-lived GitHub PAT.
        </li>
        <li>
          <strong>Vercel</strong> — installs the Vaubaan Marketplace Integration on the team. After
          install, Vercel returns an OAuth-issued team access token that we hold encrypted at rest.
        </li>
        <li>
          <strong>Supabase</strong> — paste a Supabase Management API PAT (the long{' '}
          <code>sbp_…</code> string from your account &rarr; tokens page). The PAT inherits the
          permissions of the human who created it.
        </li>
        <li>
          <strong>Railway</strong> — paste a Railway account/team token. Used by the GraphQL
          Backboard for env-var management.
        </li>
        <li>
          <strong>bash / SSH</strong> — declare hosts with their connection descriptors. Each
          binding annotates which host the agent may operate on.
        </li>
      </ul>
      <p>
        Once connected, the card on <em>Cloud providers</em> lists who granted access, the account
        it&apos;s pointing at, the scope, and the concrete resources Vaubaan can see. Click into a
        provider (<code>/orgs/[slug]/providers/[provider]</code>) to browse its data-model and the
        full risk catalog (every <code>RiskId</code>, its <code>matches</code> pattern, its 6D
        vector, and any <code>acceptable_in_envs</code> restriction).
      </p>

      <h2 id="create-project">4. Create a project</h2>
      <p>
        Open <em>Projects</em> in the sidebar and click <strong>+ New project</strong>. Pick a
        machine-friendly slug — that&apos;s what appears in URLs and the audit log. Projects are the
        unit you&apos;ll typically partition agents by (one project per app, per environment, or per
        customer). Each project carries its own risk-policy overrides — see{' '}
        <a href="#risks-policy">§8</a>.
      </p>

      <h2 id="bind-resources">5. Bind resources</h2>
      <p>
        Open a project and click <strong>+ Bind a resource</strong>. You&apos;ll see the connected
        providers and the resources Vaubaan can actually reach. Pick one. The binding ties{' '}
        <code>(project, provider, resource_ref, env?)</code> into a tuple — every MCP call from this
        project is dispatched against these bindings, and the runtime qualifies each{' '}
        <code>RiskId</code> by binding before checking acceptance.
      </p>
      <p>
        Examples of <code>resource_ref</code> shapes:
      </p>
      <ul>
        <li>
          GitHub: <code>acme/website</code> (owner/repo)
        </li>
        <li>
          Vercel: <code>prj_AbCd1234</code> (Vercel project id)
        </li>
        <li>
          Supabase: <code>abcdefghij1234567890</code> (20-char project ref); set{' '}
          <code>env: &quot;staging&quot;</code> or <code>&quot;prod&quot;</code> so the risk catalog
          can disambiguate.
        </li>
        <li>
          Railway: <code>&lt;service-id&gt;</code> with an env tag.
        </li>
        <li>
          bash/SSH: a host descriptor (e.g. <code>ops-bastion-1</code>).
        </li>
      </ul>

      <h2 id="tokens">6. Tokens &amp; delegation</h2>
      <p>
        Inside a project, open <em>Tokens</em> &rarr; <strong>+ New token</strong>. The form asks
        for a name, an optional TTL, single-use, and shows a checklist of risks scoped to the
        project&apos;s bindings. Tick what the agent needs. Submit.
      </p>
      <p>
        The token is shown <strong>once</strong> on creation — copy it into your agent config now.
        Format: <code>vbn_live_&lt;prefix&gt;_&lt;secret&gt;</code>. We store an argon2id hash, not
        the raw key — there is no recovery path. Revoke and re-issue if lost.
      </p>
      <p>
        Every token is a row in a single <code>tokens</code> table. A <em>root token</em> has{' '}
        <code>parent_id = NULL</code> and is created only via the UI (humans bootstrap the chain).
        Once you have a root, you (or your agent) can mint children programmatically by POSTing to{' '}
        <code>/api/v1/tokens/mint</code> with the parent token as Bearer. Each child:
      </p>
      <ul>
        <li>
          inherits a frozen <code>delegation_chain</code> snapshot — useful for forensics later even
          if the parent is renamed or revoked;
        </li>
        <li>
          must request a strict subset of the parent&apos;s <code>accepted_risks</code>;
        </li>
        <li>must expire no later than the parent;</li>
        <li>
          cascade-deletes if the parent is deleted (<code>ON DELETE CASCADE</code>);
        </li>
        <li>
          counts against a depth cap of 5 (human &rarr; orchestrator &rarr; coder &rarr; sub-task is
          plenty of room).
        </li>
      </ul>

      <h2 id="risk-catalog">7. Risk catalog</h2>
      <p>
        Each provider ships a versioned <code>risk-catalog.yaml</code> in the repo. An entry
        declares:
      </p>
      <ul>
        <li>
          <code>id</code> — stable name, e.g. <code>github.merge-protected</code>,{' '}
          <code>supabase.bulk-row-write</code>.
        </li>
        <li>
          <code>label</code>, <code>reason</code> — what the manager sees in the checklist
          (one-liner + 1-2 sentence rationale).
        </li>
        <li>
          <code>matches</code> — a slice pattern (internal DSL) describing which concrete{' '}
          <code>(tool, args)</code> calls fall under this risk.
        </li>
        <li>
          <code>vector</code> — the 6D risk vector (reversibility, blast, data, cost, visibility,
          persistence). Used to explain the risk and to sort the picker by severity.
        </li>
        <li>
          <code>acceptable_in_envs?</code> — optional whitelist (e.g.{' '}
          <code>[&apos;preview&apos;, &apos;staging&apos;]</code>) that structurally prevents
          accepting the risk in a binding env outside the list (the only mint-time guardrail).
        </li>
      </ul>
      <p>
        Browse each provider&apos;s full catalog at{' '}
        <code>/orgs/[slug]/providers/[provider]/[plane]</code> — the page renders the
        provider&apos;s data-model graph alongside the risk catalog and the list of MCP tools that
        each risk covers.
      </p>

      <h2 id="risks-policy">8. Risks &amp; policy</h2>
      <p>
        Policy is evaluated <em>deny-by-default</em>: an MCP call is allowed only if the risks it
        touches are all in the token&apos;s <code>accepted_risks</code>. The acceptance contract is
        risk-based — &ldquo;here are the consequences I accept on behalf of this agent&rdquo; —
        rather than capability-based.
      </p>
      <p>
        The model is <strong>binary</strong>: a risk is either in <code>accepted_risks</code> (the
        agent may touch it) or it isn&apos;t (touching it returns 403). There is no intermediate
        &ldquo;approval pending&rdquo; state at mint — the operator decides which risks to grant at
        mint time, and any later widening goes through the token&apos;s{' '}
        <code>context.escalation_channel</code> (runtime, agent-driven).
      </p>
      <p>
        The only structural mint-time guardrail is <code>acceptable_in_envs</code> on the catalog
        entry: if it&apos;s declared, the operator cannot accept the risk for a binding whose env
        isn&apos;t in the list (no override).
      </p>
      <p>
        At runtime, the gateway: (1) classifies the call into slices, (2) intersects each slice with
        the provider catalog to get <code>risks_touched</code>, (3) checks{' '}
        <code>risks_touched ⊆ token.accepted_risks</code>. No DB round-trip on the hot path beyond
        the token resolution (which is cached).
      </p>
      <p>
        When the runtime denies a call, the child token can POST to its{' '}
        <code>context.escalation_channel</code> (an HTTP endpoint configured by the parent at mint)
        to ask for a re-mint with a wider scope. Vaubaan does not proxy this exchange — the parent
        decides, mints a new token, hands it back. See the agent-bootstrap doc for the client-side
        flow.
      </p>

      <h2 id="tool-calls">9. Tool calls</h2>
      <p>Point your MCP-aware client (Claude Desktop, Cursor, custom SDK) at:</p>
      <pre>
        <code>{`{
  "mcpServers": {
    "vaubaan": {
      "url": "https://vaubaan.com/mcp",
      "headers": { "Authorization": "Bearer vbn_live_…" }
    }
  }
}`}</code>
      </pre>
      <p>
        The gateway advertises only the tools whose risks fit your token&apos;s envelope. The agent
        sees a curated tool list, not the union of every provider — that&apos;s the deny-by-default
        contract surfacing through tool discovery.
      </p>
      <p>
        When a tool call would touch a risk the token hasn&apos;t accepted, the gateway returns:
      </p>
      <pre>
        <code>{`HTTP/1.1 403 Forbidden
{
  "error": "risk-not-accepted",
  "missing_risks": ["supabase[prod].bulk-row-write"],
  "executed_slice": "supabase.project[…].schema[public].table[users].row[*].W",
  "hint": "Re-mint a token with this risk accepted, or restrict the operation."
}`}</code>
      </pre>
      <p>
        The response is actionable: the agent (or its orchestrator) can either narrow the operation,
        mint a wider token if it has the authority, or — for a child agent — POST its{' '}
        <code>context.escalation_channel</code> asking the parent to widen the envelope. Vaubaan
        itself stays out of that escalation hop: it&apos;s a direct child &rarr; parent exchange.
      </p>
      <p>
        For agents that need a self-contained primer (auth, JSON-RPC shape, tool catalog, error
        model), point them at{' '}
        <a href="/agent-bootstrap.md">
          <code>https://vaubaan.com/agent-bootstrap.md</code>
        </a>{' '}
        — raw markdown, curl-friendly, single source of truth.
      </p>

      <h2 id="audit">10. Audit log</h2>
      <p>Every call — allowed or denied — is logged with:</p>
      <ul>
        <li>
          <code>tool</code> + <code>args_hash</code> (sha256 of the args, never the raw values),
        </li>
        <li>
          <code>slices_executed</code> — the technical slice path(s) the call hit,
        </li>
        <li>
          <code>risks_touched</code> — the business-intention risks those slices resolved to,
        </li>
        <li>
          <code>token_accepted_risks</code> — a snapshot of the token&apos;s envelope at call time
          (so the decision stays reproducible even if the token is later edited),
        </li>
        <li>
          <code>delegation_chain</code> — a frozen snapshot of the token&apos;s ancestry chain,
        </li>
        <li>
          <code>decision</code>, <code>binding_used</code>.
        </li>
      </ul>
      <p>
        Org-level <em>Audit log</em> shows all calls across projects; the per-project log scopes to
        one project. We keep 90 days. Forensic filtering by root token is trivial:{' '}
        <code>
          WHERE delegation_chain @&gt;
          &apos;[&#123;&quot;id&quot;:&quot;&lt;root_id&gt;&quot;&#125;]&apos;
        </code>{' '}
        surfaces every action that descends from a given root, even after children are revoked.
      </p>

      <h2 id="billing">11. Billing &amp; plans</h2>
      <p>
        Vaubaan is metered by <em>allowed</em> MCP calls per month, with included quotas per plan.
        Denied calls are free — we don&apos;t want to disincentivize tight envelopes. Plan changes
        and invoices appear on the <Link href="/pricing">pricing</Link> page; billing portal is
        reachable from your org settings (coming soon — until then, contact us).
      </p>

      <h2 id="security">12. Security model</h2>
      <p>
        Upstream tokens are stored encrypted at rest (Supabase Vault). The gateway mints
        installation tokens just-in-time for GitHub; for Vercel, Supabase, and Railway the encrypted
        long-lived token is decrypted in the request hot-path only. Vaubaan tokens are stored as
        argon2id hashes — no recovery if lost. Row-level security on Supabase enforces per-org
        isolation at the database layer. No data crosses tenant boundaries.
      </p>
      <p>
        Detailed threat model and sub-processor list: <Link href="/security">/security</Link>{' '}
        &middot; <Link href="/subprocessors">/subprocessors</Link>.
      </p>

      <hr />
      <p>
        Programmatic API (mint children, preview risks, revoke):{' '}
        <Link href="/docs/mgmt">/docs/mgmt</Link>. Still stuck?{' '}
        <Link href="/support">Open a ticket</Link>.
      </p>
    </ProseWrap>
  );
}
