import type { Metadata } from 'next';
import Link from 'next/link';
import { ProseHeader, ProseWrap, Toc } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Programmatic API — Vaubaan',
  description:
    'Drive Vaubaan from a programmatic client: any vbn_live_* token can preview, mint child tokens with a strict-subset risk envelope, rename, or revoke.',
};

export default function MgmtDocsPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Documentation"
        title="Programmatic API"
        lead="Drive Vaubaan from any client that holds a token: preview risks for a project, mint child tokens with a strict-subset envelope, rename, revoke. One Bearer credential — vbn_live_* — for every operation."
      />

      <Toc
        items={[
          { id: 'who-this-is-for', label: '1. Who this is for' },
          { id: 'concepts', label: '2. Concepts' },
          { id: 'quickstart', label: '3. Quickstart' },
          { id: 'endpoints', label: '4. Endpoints' },
          { id: 'examples', label: '5. End-to-end example' },
          { id: 'advanced', label: '6. Advanced concepts' },
          { id: 'security', label: '7. Security & rotation' },
        ]}
      />

      <h2 id="who-this-is-for">1. Who this is for</h2>
      <p>
        You&apos;re building (or operating) a service that needs to spin up an MCP-authenticated
        coding session on demand — typically a bootstrap script that boots Claude Code / Cursor / a
        custom agent against a checked-out repo and lets it talk to the cloud through Vaubaan.
      </p>
      <p>
        You may also be writing the orchestrator itself: an agent that holds its own token and needs
        to delegate to one-shot sub-agents with a stricter envelope per task.
      </p>

      <h2 id="concepts">2. Concepts</h2>
      <p>
        There is <strong>one</strong> credential type in Vaubaan:
      </p>
      <ul>
        <li>
          <strong>Token</strong> — <code>vbn_live_&lt;prefix&gt;_&lt;secret&gt;</code>. Every token
          row carries an <code>accepted_risks: RiskId[]</code> envelope, an optional{' '}
          <code>parent_id</code>, and a frozen <code>delegation_chain</code>. The same token can be
          used both as <em>Authorization</em> for <code>/mcp</code> tool calls and as Bearer on the{' '}
          <code>/api/v1/tokens/*</code> endpoints below to mint children.
        </li>
      </ul>
      <p>The key constraints on delegation:</p>
      <ul>
        <li>
          A child&apos;s <code>accepted_risks</code> must be a strict subset of the parent&apos;s
          (you can&apos;t escalate by minting).
        </li>
        <li>
          A child&apos;s <code>expires_at</code> can&apos;t outlive the parent (you can&apos;t
          extend by minting).
        </li>
        <li>
          A <em>root</em> token (<code>parent_id IS NULL</code>) can only be created from the UI —
          humans bootstrap the chain. From there, any agent can mint downward.
        </li>
        <li>Max delegation depth is 5.</li>
      </ul>
      <p>
        If a token leaks, the blast radius is bounded by its <code>accepted_risks</code>, its
        bindings, and its TTL. Revoking a token cascade-revokes all its descendants via the{' '}
        <code>parent_id</code> foreign key.
      </p>

      <h2 id="quickstart">3. Quickstart</h2>
      <ol>
        <li>
          <strong>Bootstrap a root token via the UI.</strong> Sign in, open your project, click{' '}
          <em>Tokens &rarr; + New token</em>, tick the risks the orchestrator can ever grant
          downstream, submit. Copy the <code>vbn_live_…</code> shown once.
        </li>
        <li>
          <strong>
            Store it as <code>VAUBAAN_TOKEN</code>
          </strong>{' '}
          (Infisical, Vault, Doppler, AWS Secrets Manager, plain env in a single-tenant VM —
          whatever you already use). The client never logs the raw value.
        </li>
        <li>
          <strong>
            Set <code>VAUBAAN_BASE_URL</code>
          </strong>{' '}
          — <code>https://vaubaan.com</code> in prod, <code>http://localhost:3000</code> in local
          dev.
        </li>
        <li>
          On every session, your client POSTs to <code>/api/v1/tokens/mint</code> with that token as
          Bearer to spin up an ephemeral child for the agent, hands the child <code>api_key</code>{' '}
          to the agent, and revokes it (or lets the TTL expire) when done.
        </li>
      </ol>

      <h2 id="endpoints">4. Endpoints</h2>
      <p>
        All endpoints below take <code>Authorization: Bearer vbn_live_…</code>. There is no separate
        management-key world — any active token can call them, subject to the
        subset/depth/expires_at invariants below. Endpoints go through the regular REST rate limit
        (60 req/min per source IP).
      </p>

      <h3>
        <code>POST /api/v1/tokens/preview</code>
      </h3>
      <p>
        Compute <code>acceptable</code> / <code>inherited</code> for each requested risk × binding,
        without minting anything. Useful for UIs and for agents that want to validate the envelope
        before posting <code>mint</code>.
      </p>
      <p>Body:</p>
      <pre>
        <code>{`{
  "projectSlug": "website",          // or projectId
  "bindings": [
    { "provider": "github",   "resource_ref": "acme/website", "env": null },
    { "provider": "supabase", "resource_ref": "abcdefghij1234567890", "env": "staging" },
    { "provider": "vercel",   "resource_ref": "prj_AbCd1234", "env": "preview" }
  ],
  "accepted_risks": [
    "github.read-code",
    "github.feature-branch-write",
    "supabase[staging].row-write-one",
    "vercel.deploy-preview"
  ]
}`}</code>
      </pre>
      <p>
        Returns <code>200</code> with:
      </p>
      <pre>
        <code>{`{
  "risks": [
    {
      "id": "supabase[staging].row-write-one",
      "label": "Write a single Supabase row on staging",
      "reason": "…",
      "vector": { /* 6D */ },
      "acceptable": true,            // catalog acceptable_in_envs OK
      "inherited":  true             // risk is in parent's accepted_risks
    },
    …
  ],
  "not_acceptable": [],              // RiskIds where acceptable === false
  "not_inherited":  [],              // RiskIds where inherited === false
  "ok": true                         // both arrays empty
}`}</code>
      </pre>

      <h3>
        <code>POST /api/v1/tokens/mint</code>
      </h3>
      <p>Mint a child token under the caller&apos;s envelope. Body:</p>
      <pre>
        <code>{`{
  "name": "coder-feature-x",          // optional, defaults to "<scope>-<random8>"
  "scope": "project",                 // "org" | "project"
  "projectSlug": "website",           // required when scope='project' (or projectId)
  "bindings": [                       // required when scope='project'
    { "provider": "github", "resource_ref": "acme/website", "env": null }
  ],
  "accepted_risks": [
    "github.read-code",
    "github.feature-branch-write"
  ],
  "denied_risks": [],                 // optional opt-outs (forensic trace, runtime ignores)
  "context": {                        // optional
    "task": "implement feature X",
    "agent_id": "claude-coder-1",
    "escalation_channel": {
      "transport": "http",
      "endpoint_url": "https://orchestrator.dev/escalations",
      "auth_token": "<shared secret child→parent>"
    }
  },
  "ttlHours": 24,                     // default 24, max 168 (7 days)
  "ttlSeconds": 600,                  // alt — requires "singleUse": true, max 3600
  "singleUse": false
}`}</code>
      </pre>
      <p>Possible responses:</p>
      <ul>
        <li>
          <code>201</code> with <code>{`{ token, api_key, expires_at, accepted_risks }`}</code> on
          success. The <code>api_key</code> is the only place the raw secret is ever exposed.
        </li>
        <li>
          <code>403</code> with <code>{`{ error, not_acceptable, not_inherited, risks }`}</code>{' '}
          when at least one risk is not acceptable in the binding env (catalog{' '}
          <code>acceptable_in_envs</code>) OR not in your token&apos;s <code>accepted_risks</code>{' '}
          (subset rule).
        </li>
        <li>
          <code>403</code> with <code>{`{ error }`}</code> on a subset / depth / expires_at
          invariant violation (max-depth = 5, child can&apos;t outlive parent).
        </li>
        <li>
          <code>400</code> on schema / TTL violation.
        </li>
      </ul>

      <h3>
        <code>PATCH /api/v1/tokens/:tokenId</code>
      </h3>
      <p>Update a token&apos;s name or revoke it. Body:</p>
      <pre>
        <code>{`{
  "orgSlug": "acme",
  "name":   "new-name",       // optional — must match /^[a-z0-9](-?[a-z0-9])*$/
  "status": "revoked"         // optional — "active" | "revoked"
}`}</code>
      </pre>
      <p>
        Revoking flushes the gateway cache so the next <code>/mcp</code> call rejects within ≤ 1
        round-trip.
      </p>

      <h3>
        <code>DELETE /api/v1/tokens/:tokenId?orgSlug=acme</code>
      </h3>
      <p>
        Physically delete the token row. Children are cascade-deleted via the <code>parent_id</code>{' '}
        foreign key. <code>audit_log</code> entries survive — their <code>delegation_chain</code>{' '}
        snapshot keeps forensics working.
      </p>

      <h2 id="examples">5. End-to-end example</h2>
      <p>
        Reproduces the live <code>scripts/e2e-mint-flow.mjs</code> flow against{' '}
        <code>$VAUBAAN_BASE_URL</code> with the parent token <code>$VAUBAAN_TOKEN</code>.
      </p>
      <pre>
        <code>{`# 1. Preview — what's acceptable and inherited?
curl -sS -X POST "$VAUBAAN_BASE_URL/api/v1/tokens/preview" \\
  -H "Authorization: Bearer $VAUBAAN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectSlug": "website",
    "bindings": [
      { "provider": "github", "resource_ref": "acme/website", "env": null }
    ],
    "accepted_risks": ["github.read-code", "github.feature-branch-write"]
  }'

# Response (truncated):
# {
#   "risks": [{ "id": "github.read-code", "acceptable": true, "inherited": true, ... }, ...],
#   "not_acceptable": [],
#   "not_inherited": [],
#   "ok": true
# }

# 2. Mint a single-use, 10-minute child token.
MINT=$(curl -sS -X POST "$VAUBAAN_BASE_URL/api/v1/tokens/mint" \\
  -H "Authorization: Bearer $VAUBAAN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "coder-feature-x",
    "scope": "project",
    "projectSlug": "website",
    "bindings": [
      { "provider": "github", "resource_ref": "acme/website", "env": null }
    ],
    "accepted_risks": ["github.read-code", "github.feature-branch-write"],
    "ttlSeconds": 600,
    "singleUse": true
  }')
CHILD_API_KEY=$(echo "$MINT" | jq -r .api_key)
CHILD_TOKEN_ID=$(echo "$MINT" | jq -r .token.id)

# 3. Hand the child key to the agent. Discover tools.
curl -sS -X POST "$VAUBAAN_BASE_URL/mcp" \\
  -H "Authorization: Bearer $CHILD_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 4. Call a tool.
curl -sS -X POST "$VAUBAAN_BASE_URL/mcp" \\
  -H "Authorization: Bearer $CHILD_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": {
      "name": "github__get_file_contents",
      "arguments": { "owner": "acme", "repo": "website", "path": "README.md" }
    }
  }'

# 5. Revoke when done (or let the TTL expire).
curl -sS -X DELETE \\
  "$VAUBAAN_BASE_URL/api/v1/tokens/$CHILD_TOKEN_ID?orgSlug=acme" \\
  -H "Authorization: Bearer $VAUBAAN_TOKEN"
# → { "ok": true }`}</code>
      </pre>

      <h2 id="advanced">6. Advanced concepts</h2>

      <h3>
        6.1 <code>delegation_chain</code>
      </h3>
      <p>Every token carries a frozen snapshot of its ancestry. Format:</p>
      <pre>
        <code>{`delegation_chain: Array<{
  id: string;             // UUID of the ancestor token
  name: string;
  depth: number;          // 0 = root
  scope: 'org' | 'project';
  created_at: string;     // ISO
  created_by: string | null;
}>;`}</code>
      </pre>
      <p>
        Order: root at <code>[0]</code>, parent at <code>[length-1]</code>. Root tokens carry an
        empty array. The chain is snapshotted both on <code>tokens.delegation_chain</code> and on
        each <code>audit_log</code> row at call time, so rename / revoke of an ancestor never
        mutates historical audit. Forensic query: every action descending from a root is{' '}
        <code>
          WHERE delegation_chain @&gt;
          &apos;[&#123;&quot;id&quot;:&quot;&lt;root_id&gt;&quot;&#125;]&apos;
        </code>
        .
      </p>

      <h3>
        6.2 <code>escalation_channel</code>
      </h3>
      <p>
        When a child agent gets a <code>403 risk-not-accepted</code>, it can ask its parent for a
        wider token by reading <code>context.escalation_channel</code> from its own token context
        and POSTing directly. Vaubaan stays out of this hop — it&apos;s a child &harr; parent
        exchange. Convention:
      </p>
      <pre>
        <code>{`POST <context.escalation_channel.endpoint_url>
Authorization: Bearer <context.escalation_channel.auth_token>
Content-Type: application/json

{
  "child_token_id": "tok_abc",
  "risks_needed":   ["supabase[prod].bulk-row-write"],
  "justification":  "Without this call the Stripe rotation is incomplete.",
  "executed_slice": "supabase.project[…].row[*].W"
}`}</code>
      </pre>
      <p>
        The parent decides locally: cede (mint a new child with the wider envelope, hand it back),
        refuse (return 403), or escalate to <em>its</em> own parent via the same mechanism. The SDK
        side handles the re-call with the new <code>api_key</code>.
      </p>

      <h3>
        6.3 <code>single_use</code>
      </h3>
      <p>
        Set <code>singleUse: true</code> with a short <code>ttlSeconds</code> (≤ 3600) to mint a
        token that&apos;s consumed by the first MCP call that matches its envelope. Use this for
        one-off tasks where the agent shouldn&apos;t retain residual authority after the action
        completes.
      </p>

      <h3>6.4 Catalog drift</h3>
      <p>
        Risk catalogs are versioned in the repo. Adding a new <code>RiskId</code> can leave existing
        tokens that touched its <code>matches</code> pattern but never accepted it falling in deny
        on the next call. Renaming or removing a <code>RiskId</code> is not allowed; entries are
        deprecated (<code>deprecated: true</code>) and kept around so existing tokens keep working.
      </p>

      <h2 id="security">7. Security &amp; rotation</h2>
      <ul>
        <li>
          <strong>Rotate your bootstrap token</strong> by minting a new root in the UI, deploying
          the new env var, then revoking the old one (PATCH <code>status: &apos;revoked&apos;</code>
          or DELETE). Children of the old root cascade-revoke; agents holding the old key get 401 on
          the next call.
        </li>
        <li>
          <strong>Revoke a leaked child</strong> via{' '}
          <code>PATCH /api/v1/tokens/:tokenId {`{ status: 'revoked' }`}</code>. The gateway picks up
          the revocation within the cache TTL (60 s) or instantly on cache miss.
        </li>
        <li>
          <strong>Lost a token?</strong> Argon2id at rest — no recovery. Re-mint from the parent and
          update the consumer.
        </li>
        <li>
          <strong>Audit by chain</strong> — every MCP call carried by a child shows the full
          delegation chain on its audit row. You can attribute activity to a given session, root, or
          ancestor at any depth without recursive joins.
        </li>
      </ul>

      <hr />
      <p>
        Operator-side reference: <Link href="/docs">/docs</Link>. Design rationale: see{' '}
        <code>docs/decisions/unified-tokens-delegation-chain-and-escalation-channel.md</code>,{' '}
        <code>docs/decisions/unified-gates-drop-confirm.md</code>, and{' '}
        <code>docs/spec/gateway-risk-model.md</code> in the repo.
      </p>
    </ProseWrap>
  );
}
