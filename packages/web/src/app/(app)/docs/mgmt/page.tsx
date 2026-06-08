import type { Metadata } from 'next';
import Link from 'next/link';
import { ProseHeader, ProseWrap, Toc } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Management API — Vaubaan',
  description:
    'Use the Vaubaan Management API: create a management key, discover projects, mint and revoke ephemeral access tokens with the capabilities they need, from a programmatic client.',
};

export default function MgmtDocsPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Documentation"
        title="Management API"
        lead="Drive Vaubaan from a programmatic client (CI job, bootstrap script, automation). The caller authenticates with an org-scoped management key, discovers what's available, and mints (or revokes) short-lived access tokens."
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
        coding session on demand — typically a bootstrap script that boots Claude Code / Cursor / a
        custom agent against a checked-out repo and lets it talk to the cloud through Vaubaan.
      </p>
      <p>
        The caller is not a human and not an MCP consumer itself. It&apos;s an admin client — could
        be a CI job, a daemon, a cron, whatever.
      </p>

      <h2 id="concepts">2. Two credentials, not one</h2>
      <p>Vaubaan deliberately separates two credential types:</p>
      <ul>
        <li>
          <strong>Management key</strong> — <code>vbn_mgmt_…</code>, org-scoped, long-lived.
          Authenticates the caller against <code>/api/v1/mgmt/*</code>. <strong>Cannot</strong> be
          used on the MCP gateway. One per client (or per env: staging, prod).
        </li>
        <li>
          <strong>Access token</strong> — <code>vbn_live_…</code>, project-scoped, ephemeral. What
          the agent sends on every MCP call. Carries a set of <em>capabilities</em> = the exact
          operations the gateway will allow. Mint a fresh one per session with a TTL.
        </li>
      </ul>
      <p>
        If the management key leaks, the attacker can mint access tokens in the bound org until you
        revoke the key — but they can&apos;t consume MCP directly with it. If an access token leaks,
        the blast radius is limited by its capabilities, its project scope, and its TTL.
      </p>

      <h2 id="setup">3. Setup</h2>
      <ol>
        <li>
          In Vaubaan, open <em>Settings → Management keys</em> on the target org, click{' '}
          <strong>Create</strong>, copy the <code>vbn_mgmt_…</code> shown once.
        </li>
        <li>
          Store it as <code>VAUBAAN_MCP_GATEWAY_MGMT_KEY</code>. Use whatever secret manager you
          already have (Infisical, Vault, Doppler, AWS Secrets Manager, plain env in a single-tenant
          VM). The client never logs the raw value.
        </li>
        <li>
          Configure <code>VAUBAAN_MCP_GATEWAY_BASE_URL</code> — <code>https://vaubaan.com</code> in
          prod,
          <code>http://localhost:3000</code> in local dev.
        </li>
      </ol>

      <h2 id="flow">4. End-to-end flow</h2>
      <p>
        On every session, the client does three calls. Snippets below use <code>curl</code> for
        clarity — port them to whatever HTTP client you use.
      </p>

      <h3>4.1 Know the capabilities you need</h3>
      <p>
        There&apos;s no catalog to fetch — capabilities are a fixed grammar, not org-scoped objects.
        A capability is a shorthand string <code>plane[/operand]:action[@env]</code>. Pick the set
        the session needs, for example:
      </p>
      <ul>
        <li>
          <code>source:read</code>, <code>source:propose</code>, <code>source:apply</code> — read,
          PR, merge code.
        </li>
        <li>
          <code>runtime:apply@staging</code>, <code>runtime:apply@prod</code> — deploy.
        </li>
        <li>
          <code>runtime/settings:apply@prod</code> — change prod config / secrets.
        </li>
        <li>
          <code>data:read@staging</code>, <code>data:read@prod</code> — read data.
        </li>
      </ul>
      <p>
        Pass them as the <code>capabilities</code> array in step 4.3. The gateway maps each MCP call
        to a required capability in code (per-provider <code>classify()</code>) and allows it only
        if the token carries a covering capability.
      </p>

      <h3>4.2 Discover projects and bindings</h3>
      <pre>
        <code>{`curl -sS "$VAUBAAN_MCP_GATEWAY_BASE_URL/api/v1/mgmt/projects" \\
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
        Use <code>slug</code> as the <code>projectSlug</code> in step 4.3. Inspect the{' '}
        <code>bindings</code> array to know which providers (and environments) are wired up —
        there&apos;s no point granting <code>runtime:apply@prod</code> to a session whose project
        has no prod runtime binding.
      </p>

      <h3>4.3 Mint an ephemeral access token</h3>
      <pre>
        <code>{`curl -sS -X POST "$VAUBAAN_MCP_GATEWAY_BASE_URL/api/v1/mgmt/tokens" \\
  -H "Authorization: Bearer $VAUBAAN_MCP_GATEWAY_MGMT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectSlug": "website",
    "capabilities": ["source:read", "source:propose", "runtime:apply@staging"],
    "ttlHours": 24
  }'

# Response:
# {
#   "access_token": { "id": "...", "name": "mgmt-abc12345", "project_id": "...", "expires_at": "2026-05-28T15:00:00Z", ... },
#   "api_key":     "vbn_live_AbCdEfGh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
#   "expires_at":  "2026-05-28T15:00:00Z"
# }`}</code>
      </pre>
      <p>
        <code>ttlHours</code> defaults to <strong>24</strong>, hard-capped at <strong>168</strong>{' '}
        (7 days). Past <code>expires_at</code> the gateway returns 401 with
        <code>access token has expired</code> — renew before that.
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
        The agent calls <code>tools/list</code> and only sees the tools its capabilities allow.
        Every call is policy-checked and audited under the org.
      </p>

      <h3>4.5 Revoke the access token after the session</h3>
      <pre>
        <code>{`curl -sS -X DELETE "$VAUBAAN_MCP_GATEWAY_BASE_URL/api/v1/mgmt/tokens/$TOKEN_ID" \\
  -H "Authorization: Bearer $VAUBAAN_MCP_GATEWAY_MGMT_KEY"

# Response: 200 { "ok": true }`}</code>
      </pre>
      <p>
        Use the <code>access_token.id</code> returned at mint time. Cleaning up explicitly avoids
        accumulating expired-but-not-yet-purged rows in the DB. Forgotten tokens are still
        eventually deleted server-side once they sit past their <code>expires_at</code> for 7 days.
      </p>

      <h2 id="reference">5. API reference</h2>
      <p>
        All endpoints below take <code>Authorization: Bearer vbn_mgmt_…</code>. They are{' '}
        <strong>not</strong> rate-limited at the gateway tier — they go through the regular REST
        rate limit (60 req/min per source IP).
      </p>

      <h3>
        <code>GET /api/v1/mgmt/projects</code>
      </h3>
      <p>
        Returns{' '}
        <code>
          {`{ projects: [{ id, slug, name, created_at, bindings: [{ provider, resource_ref, display_name }] }] }`}
        </code>
        . Lists every project of the bound org and its provider bindings.
      </p>

      <h3>
        <code>POST /api/v1/mgmt/tokens</code>
      </h3>
      <p>
        Body:{' '}
        <code>
          {`{ projectSlug: string, capabilities: string[], name?: string, ttlHours?: number }`}
        </code>
        .
      </p>
      <ul>
        <li>
          <code>name</code> defaults to <code>mgmt-&lt;random-8&gt;</code>.
        </li>
        <li>
          <code>ttlHours</code> defaults to <strong>24</strong>, hard-capped at <strong>168</strong>{' '}
          (7 days).
        </li>
        <li>
          <code>capabilities</code> is an array of capability shorthands (e.g.{' '}
          <code>source:read</code>, <code>runtime:apply@prod</code>); each is validated against the
          grammar and stored as its full tuple.
        </li>
      </ul>
      <p>
        Returns 201 with <code>{`{ access_token, api_key, expires_at }`}</code>. The{' '}
        <code>api_key</code> is the only place the raw secret is ever exposed.
      </p>

      <h3>
        <code>DELETE /api/v1/mgmt/tokens/:tokenId</code>
      </h3>
      <p>
        Revokes (hard-deletes) the access token if it belongs to a project of the bound org. Returns{' '}
        <code>{`{ ok: true }`}</code> on success, 404 otherwise. Cache is invalidated so the next
        MCP call rejects within one round-trip.
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
          <em>Access tokens</em> page, or programmatically via{' '}
          <code>DELETE /api/v1/mgmt/tokens/:tokenId</code>. The gateway picks up the revocation
          within the cache TTL (60s) or instantly on cache miss.
        </li>
        <li>
          <strong>Lost the management key?</strong> Argon2id at rest — no recovery. Create a new one
          and rotate.
        </li>
        <li>
          <strong>Audit</strong> — every MCP call carried by a mgmt-minted token shows up under the
          project&apos;s audit log with the token name (<code>mgmt-&lt;hash&gt;</code>) so you can
          attribute activity to a given session.
        </li>
      </ul>

      <hr />
      <p>
        Operator-side reference: <Link href="/docs">/docs</Link>. ADR with the design rationale: see{' '}
        <code>docs/decisions/programmatic-access-token-minting.md</code> in the repo.
      </p>
    </ProseWrap>
  );
}
