import type { Metadata } from 'next';
import Link from 'next/link';
import { ProseHeader, ProseWrap, Toc } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Documentation — Vaubaan',
  description:
    'One-page operator guide to Vaubaan: connect a cloud provider, bind resources, issue scoped access tokens, and audit every MCP call.',
};

export default function DocsPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Documentation"
        title="Operator guide"
        lead="Connect a provider, bind resources to a project, issue scoped access tokens for your agents, and audit every call. One page, the whole product."
      />

      <Toc
        items={[
          { id: 'mental-model', label: '1. Mental model' },
          { id: 'connect-provider', label: '2. Connect a provider' },
          { id: 'create-project', label: '3. Create a project' },
          { id: 'bind-resources', label: '4. Bind resources' },
          { id: 'access-tokens', label: '5. Access tokens' },
          { id: 'capabilities', label: '6. Capabilities & policy' },
          { id: 'agent-config', label: '7. Configure your agent' },
          { id: 'audit', label: '8. Audit log' },
          { id: 'billing', label: '9. Billing & plans' },
          { id: 'security', label: '10. Security model' },
        ]}
      />

      <h2 id="mental-model">1. Mental model</h2>
      <p>
        Vaubaan is a multi-tenant MCP (Model Context Protocol) gateway. Your AI agents talk to one
        URL — <code>https://vaubaan.com/mcp</code> — authenticate with a single access token, and we
        broker every call to GitHub, Vercel, and Supabase under policies you control.
      </p>
      <p>The objects you'll work with:</p>
      <ul>
        <li>
          <strong>Organization</strong> — your tenant. Has members, providers, projects, an audit
          log. Most teams have one.
        </li>
        <li>
          <strong>Provider</strong> — GitHub, Vercel, or Supabase. Connected once per org, holds the
          long-lived upstream token (App install for GitHub, OAuth for Vercel, PAT for Supabase).
        </li>
        <li>
          <strong>Project</strong> — a sub-scope inside the org (e.g. <code>website</code>,{' '}
          <code>backoffice</code>). Holds bindings and access tokens.
        </li>
        <li>
          <strong>Binding</strong> — a project-scoped pointer to one concrete upstream resource: a
          GitHub repo, a Vercel project, or a Supabase project.
        </li>
        <li>
          <strong>Access token</strong> — what your agent sends. Project-scoped, revocable, and
          carries a set of <em>capabilities</em>.
        </li>
        <li>
          <strong>Capability</strong> — a single grant in the form{' '}
          <code>provider:plane/level:action[@env]</code> (e.g. <code>github:repo/code:read</code>,{' '}
          <code>vercel:runtime/deployment:write@prod</code>). A token&apos;s capabilities are the
          exact set of operations it may perform — deny-by-default.
        </li>
      </ul>

      <h2 id="connect-provider">2. Connect a provider</h2>
      <p>
        Go to <em>Cloud providers</em> in the sidebar and click <strong>Connect</strong> on the
        provider you want.
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
          <strong>Supabase</strong> — paste-token mode: paste a Supabase Management API PAT (the
          long <code>sbp_…</code> string from your account &rarr; tokens page). The PAT inherits the
          permissions of the human who created it.
        </li>
      </ul>
      <p>
        Once connected, the card on the <em>Cloud providers</em> page lists who granted access, the
        account it's pointing at, the scope, and the concrete resources Vaubaan can see.
      </p>

      <h2 id="create-project">3. Create a project</h2>
      <p>
        Open <em>Projects</em> in the sidebar and click <strong>+ New project</strong>. Pick a
        machine-friendly slug — that's what appears in URLs and in the audit log. Projects are the
        unit you'll typically partition agents by (one project per app, per environment, or per
        customer).
      </p>

      <h2 id="bind-resources">4. Bind resources</h2>
      <p>
        Open a project and click <strong>+ Bind a resource</strong>. You'll see the connected
        providers and the resources Vaubaan can actually reach. Pick one. The binding ties{' '}
        <code>(project, provider, resource_ref)</code> into a triple — every MCP call from this
        project will be dispatched against these bindings.
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
          Supabase: <code>abcdefghij1234567890</code> (20-char project ref)
        </li>
      </ul>

      <h2 id="access-tokens">5. Access tokens</h2>
      <p>
        Inside a project, open <em>Access tokens</em> &rarr; <strong>+ New token</strong>. Name it
        after the agent that'll carry it (e.g. <code>cursor-laptop</code>, <code>ci-bot</code>).
        Tick the capabilities it needs from the checklist (or type an arbitrary capability
        shorthand) — the token is granted exactly those.
      </p>
      <p>
        The token is shown <strong>once</strong> on creation — copy it into your agent config now.
        Format: <code>vbn_live_&lt;prefix&gt;_&lt;secret&gt;</code>. We store an argon2id hash, not
        the raw key — there is no recovery path. Revoke and re-issue if lost.
      </p>

      <h2 id="capabilities">6. Capabilities & policy</h2>
      <p>
        Policy is evaluated <em>deny-by-default</em>: an MCP call is allowed only if the token
        carries a capability that covers it. A capability is a 5-tuple written as{' '}
        <code>provider:plane/level:action[@env]</code>:
      </p>
      <ul>
        <li>
          <strong>provider</strong> — the vendor (<code>github</code>, <code>vercel</code>,{' '}
          <code>supabase</code>, <code>railway</code>, …).
        </li>
        <li>
          <strong>plane</strong> — one concentric stack of levels declared by the provider (
          <code>github→repo</code>, <code>vercel→runtime</code>, <code>supabase→db</code>; a
          provider may expose several planes).
        </li>
        <li>
          <strong>level</strong> — the slug of a ring inside that plane (<code>code</code>,{' '}
          <code>rows</code>, <code>deployment</code>, <code>config</code>, …).
        </li>
        <li>
          <strong>action</strong> — <code>read</code> or <code>write</code> (no <em>propose</em>, no{' '}
          <em>apply</em>, no <em>provision</em> — those collapse into <code>write</code> at a given
          env).
        </li>
        <li>
          <strong>env</strong> — an instance/variant slug (<code>@main</code>, <code>@prod</code>,{' '}
          <code>@feature/x</code>), dynamic — present only when the targeted data is overlaid on
          that env.
        </li>
      </ul>
      <p>The token-creation checklist surfaces the common grants:</p>
      <ul>
        <li>
          <code>github:repo/code:read</code> — read code, diffs, PRs.
        </li>
        <li>
          <code>github:repo/code:write@main</code> — merge / apply to main.
        </li>
        <li>
          <code>vercel:runtime/deployment:write@preview</code> /{' '}
          <code>vercel:runtime/deployment:write@prod</code> — deploy.
        </li>
        <li>
          <code>vercel:runtime/config:write@prod</code> — change prod env vars / secrets.
        </li>
        <li>
          <code>supabase:db/rows:read@staging</code> / <code>supabase:db/rows:read@prod</code> —
          read data.
        </li>
      </ul>
      <p>
        Need a capability that isn&apos;t on the checklist? Type the notation directly in the
        free-text field on the token page — it&apos;s validated against the grammar before it&apos;s
        accepted. The mapping from a concrete <code>(tool, args)</code> call to a required
        capability is done in code by each provider plugin&apos;s <code>classify()</code>, so
        there&apos;s no per-org rule DSL to maintain.
      </p>

      <h2 id="agent-config">7. Configure your agent</h2>
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
        The gateway advertises only the tools your capabilities allow. The agent sees a curated tool
        list, not the union of every provider — that's the deny-by-default contract surfacing
        through capability discovery.
      </p>
      <p>
        For agents that need a self-contained primer (auth, JSON-RPC shape, tool catalog, bootstrap
        recipes with <code>git clone</code>/<code>push</code> via{' '}
        <code>github__mint_install_token</code>, error model), point them at{' '}
        <a href="/agent-bootstrap.md">
          <code>https://vaubaan.com/agent-bootstrap.md</code>
        </a>{' '}
        — raw markdown, curl-friendly, single source of truth.
      </p>

      <h2 id="audit">8. Audit log</h2>
      <p>
        Every call — allowed or denied — is logged. Org-level <em>Audit log</em> shows all calls
        across projects; the per-project audit log scopes to one project. We keep 90 days. Filter by
        access token, by decision, or by time. Denials surface the exact rule that fired so you can
        triage policy.
      </p>

      <h2 id="billing">9. Billing &amp; plans</h2>
      <p>
        Vaubaan is metered by <em>allowed</em> MCP calls per month, with included quotas per plan.
        Denied calls are free — we don't want to disincentivize tight policies. Plan changes and
        invoices appear on the <Link href="/pricing">pricing</Link> page; billing portal is
        reachable from your org settings (coming soon — until then, contact us).
      </p>

      <h2 id="security">10. Security model</h2>
      <p>
        Upstream tokens are stored encrypted at rest (Supabase Vault). The gateway mints
        installation tokens just-in-time for GitHub; for Vercel and Supabase the encrypted
        long-lived token is decrypted in the request hot-path only. Access tokens are stored as
        argon2id hashes. Row-level security on Supabase enforces per-org isolation at the database
        layer. No data crosses tenant boundaries.
      </p>
      <p>
        Detailed threat model and sub-processor list: <Link href="/security">/security</Link>{' '}
        &middot; <Link href="/subprocessors">/subprocessors</Link>.
      </p>

      <hr />
      <p>
        Still stuck? <Link href="/support">Open a ticket</Link>.
      </p>
    </ProseWrap>
  );
}
