import type { Metadata } from 'next';
import Link from 'next/link';
import { ProseHeader, ProseWrap, Toc } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Runner integration — Vaubaan',
  description:
    'Integrate the Coding Agent Runner with Vaubaan: create a management key, discover roles and projects, mint ephemeral access tokens, and run sessions.',
};

export default function RunnerDocsPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Documentation"
        title="Runner integration"
        lead="Stand up the Coding Agent Runner against Vaubaan. The Runner authenticates with an org-scoped management key, discovers what's available, and mints a short-lived access token per coding session."
      />

      <Toc
        items={[
          { id: 'who-this-is-for', label: '1. Who this is for' },
          { id: 'concepts', label: '2. Two credentials, not one' },
          { id: 'setup', label: '3. Setup' },
          { id: 'flow', label: '4. End-to-end flow' },
          { id: 'reference', label: '5. API reference' },
          { id: 'security', label: '6. Security & rotation' },
        ]}
      />

      <h2 id="who-this-is-for">1. Who this is for</h2>
      <p>
        You&apos;re building (or operating) a service that needs to spin up an MCP-authenticated
        coding session on demand — typically a &ldquo;Coding Agent Runner&rdquo; that boots Claude
        Code / Cursor / a custom agent against a checked-out repo and lets it talk to the cloud
        through Vaubaan.
      </p>
      <p>The Runner is not a human and not an MCP consumer itself. It&apos;s an admin client.</p>

      <h2 id="concepts">2. Two credentials, not one</h2>
      <p>Vaubaan deliberately separates two credential types:</p>
      <ul>
        <li>
          <strong>Management key</strong> — <code>vbn_mgmt_…</code>, org-scoped, long-lived.
          Authenticates the Runner against <code>/api/v1/runner/*</code>. <strong>Cannot</strong> be
          used on the MCP gateway. One per Runner (or per env: staging, prod).
        </li>
        <li>
          <strong>Access token</strong> — <code>vbn_live_…</code>, project-scoped, ephemeral. What
          the agent sends on every MCP call. Carries <em>roles</em> = the allow/deny rules that the
          gateway enforces. The Runner mints a fresh one per session with a TTL.
        </li>
      </ul>
      <p>
        If the management key leaks, the attacker can mint access tokens in the bound org until you
        revoke the key — but they can&apos;t consume MCP directly with it. If an access token leaks,
        the blast radius is limited by its roles, its project scope, and its TTL.
      </p>

      <h2 id="setup">3. Setup</h2>
      <ol>
        <li>
          In Vaubaan, open <em>Settings → Management keys</em> on the target org, click{' '}
          <strong>Create</strong>, copy the <code>vbn_mgmt_…</code> shown once.
        </li>
        <li>
          Store it on the Runner host as <code>VAUBAAN_MCP_GATEWAY_MGMT_KEY</code>. Use whatever
          secret manager you already have (Infisical, Vault, Doppler, AWS Secrets Manager, plain env
          in a single-tenant VM). The Runner never logs the raw value.
        </li>
        <li>
          Configure <code>VAUBAAN_MCP_GATEWAY_BASE_URL</code> — <code>https://vaubaan.com</code> in
          prod,
          <code>http://localhost:3000</code> in local dev.
        </li>
      </ol>

      <h2 id="flow">4. End-to-end flow</h2>
      <p>
        On every session, the Runner does three calls. Snippets below use <code>curl</code> for
        clarity — port them to whatever HTTP client your Runner uses.
      </p>

      <h3>4.1 Discover available roles</h3>
      <pre>
        <code>{`curl -sS "$VAUBAAN_MCP_GATEWAY_BASE_URL/api/v1/runner/roles" \\
  -H "Authorization: Bearer $VAUBAAN_MCP_GATEWAY_MGMT_KEY"

# Response (truncated):
# {
#   "roles": [
#     { "id": "uuid-1", "name": "github:developer", "provider": "github", "is_builtin": true, "description": "..." },
#     { "id": "uuid-2", "name": "github:reader",    "provider": "github", "is_builtin": true, "description": "..." },
#     ...
#   ]
# }`}</code>
      </pre>
      <p>
        Returned roles are the union of global builtins and org-scoped custom roles. Cache the list
        and pick the <code>id</code> values you want to attach for this session.
      </p>

      <h3>4.2 Discover projects and bindings</h3>
      <pre>
        <code>{`curl -sS "$VAUBAAN_MCP_GATEWAY_BASE_URL/api/v1/runner/projects" \\
  -H "Authorization: Bearer $VAUBAAN_MCP_GATEWAY_MGMT_KEY"

# Response (truncated):
# {
#   "projects": [
#     {
#       "id": "uuid",
#       "slug": "website",
#       "name": "Website",
#       "created_at": "2026-05-22T...",
#       "bindings": [
#         { "provider": "github", "resource_ref": "acme/website", "display_name": "acme/website" }
#       ]
#     }
#   ]
# }`}</code>
      </pre>
      <p>
        The Runner uses <code>slug</code> as the <code>projectSlug</code> in step 4.3. Inspect the{' '}
        <code>bindings</code> array to know which providers are wired up — there&apos;s no point
        attaching a <code>vercel:viewer</code> role to a session targeting a project that has no
        Vercel binding.
      </p>

      <h3>4.3 Mint an ephemeral access token</h3>
      <pre>
        <code>{`curl -sS -X POST "$VAUBAAN_MCP_GATEWAY_BASE_URL/api/v1/runner/tokens" \\
  -H "Authorization: Bearer $VAUBAAN_MCP_GATEWAY_MGMT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectSlug": "website",
    "roleIds": ["<role-id-from-4.1>"],
    "ttlHours": 24
  }'

# Response:
# {
#   "access_token": { "id": "...", "name": "runner-abc12345", "project_id": "...", "expires_at": "2026-05-28T15:00:00Z", ... },
#   "api_key":     "vbn_live_AbCdEfGh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
#   "expires_at":  "2026-05-28T15:00:00Z"
# }`}</code>
      </pre>
      <p>
        <code>ttlHours</code> defaults to <strong>24</strong>, hard-capped at <strong>168</strong>{' '}
        (7 days). Past <code>expires_at</code> the gateway returns 401 with
        <code>access token has expired</code> — the Runner should renew before that.
      </p>
      <p>
        The <code>api_key</code> is shown <strong>once</strong> (argon2id at rest, no recovery).
        Pass it directly to the agent — don&apos;t persist it past the session.
      </p>

      <h3>4.4 Hand the access token to the agent</h3>
      <pre>
        <code>{`{
  "mcpServers": {
    "vaubaan": {
      "url": "$VAUBAAN_MCP_GATEWAY_BASE_URL/mcp",
      "headers": { "Authorization": "Bearer $ACCESS_TOKEN" }
    }
  }
}`}</code>
      </pre>
      <p>
        The agent calls <code>tools/list</code> and only sees the tools its roles allow. Every call
        is policy-checked and audited under the org.
      </p>

      <h2 id="reference">5. API reference</h2>
      <p>
        All endpoints below take <code>Authorization: Bearer vbn_mgmt_…</code>. They are{' '}
        <strong>not</strong> rate-limited at the gateway tier — they go through the regular REST
        rate limit (60 req/min per source IP).
      </p>

      <h3>
        <code>GET /api/v1/runner/roles</code>
      </h3>
      <p>
        Returns <code>{`{ roles: [{ id, name, provider, description, is_builtin }] }`}</code>.
        Includes global builtins and custom roles of the bound org.
      </p>

      <h3>
        <code>GET /api/v1/runner/projects</code>
      </h3>
      <p>
        Returns{' '}
        <code>
          {`{ projects: [{ id, slug, name, created_at, bindings: [{ provider, resource_ref, display_name }] }] }`}
        </code>
        . Lists every project of the bound org and its provider bindings.
      </p>

      <h3>
        <code>POST /api/v1/runner/tokens</code>
      </h3>
      <p>
        Body:{' '}
        <code>
          {`{ projectSlug: string, roleIds: string[], name?: string, ttlHours?: number }`}
        </code>
        .
      </p>
      <ul>
        <li>
          <code>name</code> defaults to <code>runner-&lt;random-8&gt;</code>.
        </li>
        <li>
          <code>ttlHours</code> defaults to <strong>24</strong>, hard-capped at <strong>168</strong>{' '}
          (7 days).
        </li>
        <li>
          <code>roleIds</code> must reference roles returned by <code>GET /runner/roles</code> (i.e.
          builtin <em>or</em> custom of the bound org).
        </li>
      </ul>
      <p>
        Returns 201 with <code>{`{ access_token, api_key, expires_at }`}</code>. The{' '}
        <code>api_key</code> is the only place the raw secret is ever exposed.
      </p>

      <h2 id="security">6. Security &amp; rotation</h2>
      <ul>
        <li>
          <strong>Rotate the management key</strong> by creating a new one, deploying the new env
          var, then deleting the old one from the Settings page. Old key is rejected immediately (no
          grace period — the cache invalidates on next call).
        </li>
        <li>
          <strong>Revoke a leaked access token</strong> from the project&apos;s{' '}
          <em>Access tokens</em> page. The gateway picks up the revocation within the cache TTL
          (60s) or instantly on cache miss.
        </li>
        <li>
          <strong>Lost the management key?</strong> Argon2id at rest — no recovery. Create a new one
          and rotate.
        </li>
        <li>
          <strong>Audit</strong> — every MCP call carried by a runner-minted token shows up under
          the project&apos;s audit log with the token name (<code>runner-&lt;hash&gt;</code>) so you
          can attribute activity to a Runner session.
        </li>
      </ul>

      <hr />
      <p>
        Operator-side reference: <Link href="/docs">/docs</Link>. ADR with the design rationale: see{' '}
        <code>docs/decisions/org-management-keys-for-runner.md</code> in the repo.
      </p>
    </ProseWrap>
  );
}
