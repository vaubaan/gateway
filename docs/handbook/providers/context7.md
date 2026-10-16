---
title: Context7 provider plugin
status: current
date: 2026-10-16
last_synced: 2026-10-16
tracks:
  - plugins/context7/src/
  - plugins/context7/tests/unit/
---

# Context7 provider plugin

> **Current.** The model was drafted in phase 1 of
> [`provider-modeler`](../../skills/provider-modeler.md), reviewed by the
> product owner on 2026-10-16 ("Decisions of the product owner", at the
> end), and is what `plugins/context7/` implements. This page describes the
> code as written.

> **Sources: an authorised exception to the Context7-first rule.** The rule
> ([`use-context7-for-provider-docs`](../../decisions/use-context7-for-provider-docs.md))
> cannot apply to Context7 itself on 2026-10-16: the anonymous monthly quota
> of `mcp.context7.com` is exhausted. Renaud authorised `WebFetch`
> restricted to Context7's official sources, `context7.com` (its docs and
> API pages) and the official repository `github.com/upstash/context7`.
> Every page read is listed in "Sources"; the facts taken from the
> repository's source code describe the open-source server, which is
> assumed to be the one hosted at `mcp.context7.com` (marked ⚠ where a rule
> depends on it). The facts marked **(live)** come from live calls made the
> same day: by the coordinator and the product owner with a key, and an
> anonymous `tools/list` (no key needed, no quota spent) from which
> `upstream-tools.json` was captured.

`@vaubaan/plugin-context7` 0.1.0, catalog version 1, tool prefix `context7__`.

**Why.** "Everything goes through our gateway, zero env" (PO). Today Claude
Code in this repository reaches Context7 directly and anonymously (the
`context7` entry of `.mcp.json`, no key), and the anonymous quota is spent.
The plugin stores a Context7 API key as a gateway connection (encrypted,
never in an environment variable or in `.mcp.json`), and agents call the
Context7 documentation tools through the execution door under a mission
token, like any other provider.

**Scope v0.1.** The two documentation tools of the Context7 MCP server,
`resolve-library-id` and `query-docs`. No administration: no library
added, refreshed or parsed, no teamspace policy read or changed (the REST
API has endpoints for those; see §5.6).

## 0. Rewrap the remote MCP, or call the REST API

Context7 exposes both: the hosted MCP server `https://mcp.context7.com/mcp`
(Streamable HTTP) and a REST API under `https://context7.com/api`
(`GET /v2/libs/search`, `GET /v2/context`, …). The MCP server is a thin
layer over the same two REST endpoints (`searchLibraries` →
`/v2/libs/search`, `fetchLibraryContext` → `/v2/context`, in
`packages/mcp/src/lib/api.ts`).

**Decision: rewrap the MCP server for the two tools, and use the REST
API for what the gateway does around them** (checking a pasted key,
discovery, diagnosing a refused call). This is the Railway shape — MCP
tools forwarded, a side API for the rest
([`railway-rewrap-remote-mcp`](../../decisions/railway-rewrap-remote-mcp.md),
[`rewrap-official-mcps`](../../decisions/rewrap-official-mcps.md)).

For the rewrap:

- **Nothing changes for the agent.** The tools, their names, their
  descriptions and their answers are the ones Claude Code uses today
  through the direct `context7` server — the descriptions carry Context7's
  own usage rules ("Do not call this tool more than 3 times per question",
  "Do not include any sensitive or confidential information such as API
  keys, passwords, credentials, personal data" in the `query` field). With
  REST, the plugin would write and maintain those descriptions and the text
  formatting of the answers itself.
- **The server is forwardable.** It is stateless — "a fresh server
  instance per request, no Mcp-Session-Id, no session store" (source
  comment) — so, as for Railway, `tools/call` needs no `initialize` and no
  session. The key travels as a header on each request. **(live)** A
  `tools/call` of `resolve-library-id` with `{ libraryName, query }` and
  `Authorization: Bearer <key>` answered an SSE `event: message` whose text
  starts with "Available Libraries: …": a parser of the first JSON-RPC frame,
  as Railway's, applies.
- **The surface is frozen.** **(live)** `tools/list` returns exactly two
  tools, `resolve-library-id` and `query-docs`; their declarations are
  captured verbatim into `upstream-tools.json`, as for Railway and Vercel. A
  tool Context7 adds later is unknown to the classifier and refused until it
  is modelled.

Against the rewrap, and how the design answers it:

- **Failures arrive as tool results, not statuses.** The MCP server turns a
  failed REST call into a tool result with `isError: true` on an HTTP 200
  (`outcome === "error"`; "No documentation found" is a valid answer, not an
  error). **(live)** A bad key answers HTTP 200 with the JSON-RPC result
  `{ content: [{ type: 'text', text: 'Invalid API key. …' }], isError: true }`
  in an SSE `event: message` frame, while `GET /api/v2/usage` with the same
  bad Bearer key answers HTTP 401. Its texts are fixed strings of `parseErrorResponse`: on 401
  "Invalid API key. Please check your API key. API keys should start with
  'ctx7sk' prefix.", on 429 with a key "Rate limited or quota exceeded.
  Upgrade your plan at https://context7.com/plans for higher limits.", on
  404 "The library you are trying to access does not exist. …", otherwise
  "Request failed with status N. …" — unless the REST body carries a
  `message`, which is passed instead. The SDK contract wants a provider
  failure thrown with its status. **The executor does not match the text**
  (fragile); on an upstream `isError` result it asks the REST API about the
  key (`GET /api/v2/usage`, free — "Calls to this endpoint do not count as
  requests") and throws accordingly (§6.3) — Railway's `explainMcpRefusal`
  pattern.
- **The server accepts argument aliases** that its schema does not declare:
  `userQuery` and `question` for `query`; `context7CompatibleLibraryID`,
  `libraryID` and **`libraryName`** for `libraryId` on `query-docs`
  (source ⚠). The closed argument surface of the SDK refuses them (§5.2):
  an alias would carry the library the call reads past the classifier.

REST alone was the alternative: real HTTP statuses (401, 402
`spending_limit_exceeded`, 429 with `Retry-After` and `RateLimit-*`
headers), and two extra parameters (`fast`, to skip Context7's LLM
reranking; `type`, `json` or `txt`). Rejected for v0.1 because the gain is
the error mapping, which the usage probe gives without rewriting the tools.
It stays the fallback if the hosted server changes its auth model or
becomes stateful (switch condition of the Railway ADR).

## 1. Data model

One plane, `docs`.

```
index[<ref>]            the resource: the library index one Context7 key reaches
  └─ library[<id>]      a Context7 library (/vercel/next.js, /org/project/version)
```

| Entity    | Parent  | Cardinalities      | Notes                                                                                                                                                  |
| --------- | ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index`   | none    | `one`              | The resource: what the key's teamspace can query — the public libraries its policies admit and its private sources. Not `envScopable`.                 |
| `library` | `index` | `one`, `unbounded` | One library named by its Context7 id (`query-docs`), or every library of the index (`resolve-library-id`, a search). No verb leaf: nothing is written. |

**Why the resource is the whole index.** Context7 has no per-tenant object
a mission could be limited to: libraries are global (`/vercel/next.js` is
the same for everyone), and what a key reaches is decided by its
teamspace's policies — "Every search and MCP request made with one of the
teamspace's API keys is filtered through these policies" — plus the
teamspace's private sources (Pro and Enterprise plans). Neither answer of
the REST API names the teamspace (`/v2/usage` and `/v2/policies` carry no
id or name), so there is nothing stable to key a resource on but the
connection itself. The honest model is **one resource per connection**,
with a constant `ref`.

**Why `library` is an entity and not just "the index".** It costs nothing,
it keeps the library id in the slice (the audit then says which
documentation was read), and it leaves room for a narrower risk later — a
risk on the private sources, or a restriction to named libraries — without
a new slice shape (D3: not in v0.1).

**No environment.** Context7 has no notion of environment; no entity is
`envScopable`, no `envOf`, no risk is env-scoped. The owner may still put a
label on the resource; it changes nothing.

`summary` (shown in Reference): "One account is a Context7 API key of a
teamspace. It has one resource, the library index the key can query: the
public libraries its teamspace policies allow and its private sources. The
documentation questions an agent asks are sent to Context7. There is no
environment."

## 2. Tool → slice mapping

Two rewrapped tools. Names keep the upstream spelling after the prefix, as
Railway does (`railway__get-logs`).

| Tool                           | Upstream input schema (**(live)** `tools/list`)                                           | Slice                                   | Risk                  |
| ------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------- | --------------------- |
| `context7__resolve-library-id` | `query: string` (required), `libraryName: string` (required)                              | `context7.index[<ref>].library[*].R`    | `context7.query-docs` |
| `context7__query-docs`         | `libraryId: string` (required), `query: string` (required), `language: string` (optional) | `context7.index[<ref>].library[<id>].R` | `context7.query-docs` |

Upstream annotations of both: `readOnlyHint: true`, `destructiveHint:
false`, `openWorldHint: true`, `idempotentHint: true`. Upstream titles:
"Resolve Context7 Library ID", "Query Documentation". Both stay in
`upstream-tools.json`; the gateway's declaration carries the name (prefixed),
the description and the schema's `properties` and `required`, unchanged
(`src/tools.ts`). `toolTitles`: "Find a library in Context7", "Read a
library's documentation".

- `<ref>` is the connection's single resource (§6.2). The tools take no
  resource argument: the upstream schemas have none, and a mission holds
  at most one Context7 connection, so its single resource is the target. A
  mission with no Context7 resource is denied ("no context7 resource in
  this mission"); two are impossible by construction but denied as
  ambiguous all the same.
- `<id>` is `identSegment(libraryId)` after the grammar of §5.1: the id when
  the slice grammar can carry it (`/vercel/next.js`, `/vercel/next.js/v14.3.0`
  — `/`, `.`, `~`, `-`, `_` are slice characters), `[*]` otherwise
  (`/vercel/next.js@v14.3.0`: `@` is not). The value sent upstream is
  unchanged.
- `resolve-library-id` searches every library of the index: `[*]`, whatever
  `libraryName` says. `libraryName` is a free-text product name ("Next.js"),
  not an identifier, and is never put in a slice.

## 3. Catalog and presets

### 3.1 Risks

**One named risk and the fallback.**

```yaml
provider: context7
catalog_version: 1
catalog_date: 2026-10-16

risks:
  - id: context7.query-docs
    label: 'Ask Context7 about library documentation'
    reason: >-
      The question the agent writes — which may carry code or internal
      context — is sent to Context7, a third party that stores queries; the
      documentation that comes back is third-party text. Each call also
      spends the key's monthly Context7 quota.
    matches: 'context7.index[**].library[**].R'
    vector:
      reversibility: irreversible # what was sent cannot be recalled
      blast: single
      data: data #                  free text written by the agent
      cost: moderate #              plan quota; billed overage on Pro
      visibility: public #          leaves the company
      persistence: stateless

  - id: context7.uncategorized-write
    label: 'Uncategorized write'
    reason: 'Catch-all for writes without a dedicated entry. No Context7 tool of this plugin writes.'
    matches: 'context7.**.W'
    fallback: true
    vector:
      {
        reversibility: costly,
        blast: account,
        data: data,
        cost: moderate,
        visibility: team,
        persistence: posture,
      }
```

**Why one risk for two tools.** The kit wants one entry per intent that
deserves its own decision, not one per tool. Both tools are the same act:
send a question to Context7 and read documentation back. Both send the
agent's `query` text (it is required on `resolve-library-id` too, "used to
rank results by relevance"), both read, both spend one request of the
plan's quota (Context7 counts "search and docs requests" together against
`includedInPlan`). A mission that could search libraries but not read their
documentation, or the reverse, does nothing useful: an agent resolves an id
and then queries it, or queries an id it already knows. Two risks would
only double the budget lines of every mission (D2).

**The vector is about disclosure, not about the read.** Reading public
documentation is harmless; what deserves a decision is that the gateway
lets an agent's free text leave for a third party.

- `data: data` — the query is whatever the agent writes. Context7's
  description asks the agent not to put secrets or personal data in it, and
  Context7's privacy page says the client sends "a search query formulated
  by the MCP client (not your original prompt)". Through the gateway that
  is the agent's own sentence, and nothing checks what it holds. Not
  `secret` or `pii`: the tool is not meant to carry them, and the gateway
  cannot tell.
- `visibility: public` — the closest value of the scale for "seen outside
  the company". Context7 stores the queries ("anonymously stored and used to
  benchmark retrieval accuracy and improve the documentation matching
  pipeline"; API logs retained 30 days). Kept over `team` (D4).
- `reversibility: irreversible` — a query sent cannot be withdrawn.
- `cost: moderate` — Free: 1,000 calls a month, then blocked (20 bonus calls
  a day). Pro: 2,000 calls per seat a month, then $5 per 1,000 calls, "not
  blocked" — unless the teamspace sets a spending limit (`402
spending_limit_exceeded`). Not `unbounded`: the plan or the spending limit
  bounds it, and the mission's quota bounds it again.

**The fallback** is mandatory and unreachable: no tool of this plugin
emits a write slice. It is in no preset.

**Limits.** No `infra_limits`: Context7 publishes no rate figure for any
plan (the API guide says "Higher limits based on your plan"; the plans page
lists monthly calls only), and the gateway enforces nothing else (ADR
`scope-caps-not-enforced-in-v5-0`). A 429 from Context7 is a provider
failure (§6.3).

### 3.2 Presets

**One preset, `read-only`.**

```yaml
presets:
  - id: read-only
    label: Read-only
    description: Ask Context7 about library documentation. The questions the agent writes are sent to Context7.
    entries:
      - risk_id: context7.query-docs
        quota: 300
        rate_limit: { max: 20, window_seconds: 60 }
        gate: auto
```

- The kit asks for "a read-only preset and one for daily work". With one
  risk, which is a read, the two are the same list: a second preset would
  differ by its numbers only, and the creator adjusts numbers in New
  mission anyway. `read-only` **is** the daily-work preset; the handbook and
  the README say so (D1).
- `gate: auto` — a documentation lookup asking first would make the tool
  unusable; what the gate would protect (the text of the query) cannot be
  judged from an approval card any better than from the mission.
- `rate_limit: 20 / 60 s` — Context7's descriptions say at most three calls
  of each tool per question; an agent answering one question makes one to
  four calls. Twenty a minute leaves room for a burst and stops a loop.
- `quota: 300` per period — under the Free plan's 1,000 calls a month, so
  that one recurring mission cannot spend a free key alone, and well under
  a Pro seat's 2,000. The key's quota is shared by every mission on the
  connection and by any other use of the same key: the mission's quota is a
  ceiling of the mission, not a guarantee from Context7.

## 4. Coverage

| Tool                           | Sample                                                          | Slice                                             | Risks touched         | Fallback |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------- | --------------------- | -------- |
| `context7__resolve-library-id` | `{ libraryName: 'Next.js', query: 'app router middleware' }`    | `context7.index[docs].library[*].R`               | `context7.query-docs` | no       |
| `context7__query-docs`         | `{ libraryId: '/vercel/next.js', query: 'middleware matcher' }` | `context7.index[docs].library[/vercel/next.js].R` | `context7.query-docs` | no       |
| `context7__query-docs`         | `{ libraryId: '/vercel/next.js@v14.3.0', query: '…' }`          | `context7.index[docs].library[*].R`               | `context7.query-docs` | no       |

`risksUntouched` is `[]`; `fallbackHits` is `[]`. Denied samples: a
malformed `libraryId`, an undeclared argument (an alias), a mission with no
Context7 resource.

## 5. Edge cases

### 5.1 Identifiers

| Value                                | Grammar                                                                                                                                                                                                                             | Bound to the mission                | Where it lands                                                                  | Outside the grammar                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| the resource ref                     | the constant `docs` (`pathIdent` shape); discovery writes it, the classifier compares with it                                                                                                                                       | yes — the mission's single resource | slice `index[docs]` only, never sent                                            | `context7: the resource of this mission is not a Context7 index.`     |
| `libraryId` (`query-docs`)           | `libraryId()` — a leading `/`, then 1 to 4 segments of `[A-Za-z0-9_.~@+-]`, no empty or dot-only segment, at most 500 characters (Context7's own limit on `/v2/context`), no whitespace, control character, `*`, `?`, `#`, `%`, `\` | no — libraries are global (§5.3)    | JSON-RPC argument of `tools/call`; slice `library[<id>]` through `identSegment` | `libraryId: malformed Context7 library id.`                           |
| `libraryName` (`resolve-library-id`) | `freeText()` — a product name; a string of 1 to 500 characters                                                                                                                                                                      | —                                   | JSON-RPC argument only                                                          | `libraryName: expected a non-empty string of at most 500 characters.` |
| `query`, `language`                  | `freeText()` — a string of 1 to 500 characters (Context7's limit on the REST side); `language` is optional, and when given follows the same rule                                                                                    | —                                   | JSON-RPC argument only                                                          | `query: …`, `language: …` as above                                    |

**No identifier reaches a URL.** The MCP request is one `POST` to the
constant `https://mcp.context7.com/mcp`; `libraryId`, `libraryName`,
`query` and `language` travel as JSON-RPC arguments in the body, as for
Railway. The REST calls the plugin makes itself (`GET /api/v2/usage`) carry
no argument of the agent. The identifier proof therefore runs with
`pathIdentifiers: { none: 'one JSON-RPC POST to a constant URL; identifiers
travel in the body' }`, and the plugin's own tests feed the hostile values
to `libraryId` in `classify` and `execute` (refused by the grammar, nothing
sent).

**Why a grammar for a value that never reaches a path.** The id is written
into a slice (the audit names the library read), and a library id with
`..` or a glob has no legitimate reading: refusing it is cheaper than
reasoning about what Context7 would do with it. The version forms come
from the REST reference: "Can include a version as `/vercel/next.js/v14.3.0`
or `/vercel/next.js@v14.3.0`".

### 5.2 Undeclared arguments and the upstream aliases

The rewrapped tools forward their arguments whole, so **the plugin refuses
undeclared arguments**, in `classify` and in `execute`
(`undeclaredArgumentDenial`, no routing argument):
`<name>: not an argument of '<tool>' — nothing classifies it, so it is not sent.`

This matters more here than for most plugins: the upstream server reads
aliases its schema does not declare (§0). `query-docs` with
`{ libraryName: '/evil/lib', query: '…' }` and no `libraryId` would be read
upstream as a query of `/evil/lib` while the classifier saw no library. The
closed surface refuses it before the budget. A test pins each alias
(`userQuery`, `question`, `context7CompatibleLibraryID`, `libraryID`,
`libraryName` on `query-docs`) as denied.

### 5.3 A library is not bound to anything

The gateway cannot check that a `libraryId` exists or that the key may read
it, and does not try: libraries are global, Context7's teamspace policies
decide what the key reaches, and a refused or unknown library comes back as
Context7's own answer (404 `library_not_found`, 403 `access_denied`). The
mission's resource is the whole index; the slice names the library for the
audit only. Restricting a mission to named libraries is not offered in
v0.1 (D3).

### 5.4 What leaves for Context7

The query text is the risk (§3.1). The gateway forwards it as written and
does not inspect it. Three things bound it:

- the mission holds `context7.query-docs` only if its creator accepted that
  the agent's questions go to Context7 — the reason says so in those words;
- the length: `query` is refused above 500 characters, Context7's own
  limit on the REST side (the MCP schema states none: **(live)** `tools/list`
  declares no `maxLength`), which also bounds how much context one call can
  carry;
- Context7's tool description asks the agent not to include secrets.

The gateway itself sends nothing else of the caller: no prompt, no mission,
no agent label. Context7 sees the gateway's IP address (the hosted server
records the client IP for rate limiting), the key, and "the MCP client name
and version" — the gateway's, not the agent's.

Refusing queries that look like secrets (a `vbn_live_` or `ctx7sk-` prefix,
a PEM header) is possible in the classifier but would be a promise the
gateway cannot keep in general. Not done (D5).

### 5.5 Results can carry prompt injection

Context7's answers are third-party text: snippets of libraries anyone can
add ("Adding Libraries", "Claim Your Library") and of the teamspace's own
private sources. A hostile library can hold instructions aimed at the
agent, and `resolve-library-id` can steer the agent towards a look-alike
library id. The gateway handles this as for every provider (threat model,
"A compromised or hostile provider"): **results are forwarded as they are,
never sanitised**; nothing a provider returns feeds a decision; an injected
agent still holds only its mission's risks, budget and gates. A mission
that holds only `context7.query-docs` can do nothing with an injection but
ask Context7 more questions. The provider-side mitigation is the teamspace's
library filter (quality mode: verified libraries, a minimum trust score);
the plugin's README recommends it.

Error texts follow the same rule
([`provider-error-text-stays-with-the-agent`](../../decisions/provider-error-text-stays-with-the-agent.md)):
Context7's message goes to the calling agent only; the audit and the
connection page keep the status.

### 5.6 Tools deliberately left out

The REST API also adds libraries (Git repositories, OpenAPI specs, PDFs,
websites, Confluence, Notion), refreshes them, and reads or **updates the
teamspace's policies** (`PATCH /v2/policies`). None is exposed: adding a
private source sends company content to Context7, and changing the policies
changes what every key of the teamspace reaches. They would be writes with
their own risks, and nobody has asked for them.

## 6. Credential, discovery, execution, tests

### 6.1 Credential

Kind `api-key`, one secret field.

| Member                        | Value                                                                                                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`                       | "API key"                                                                                                                                                                                                                                                                    |
| `createUrl`                   | `https://context7.com/dashboard` (the API Keys card, "Create API Key")                                                                                                                                                                                                       |
| field `api_key`               | `secret: true`, `required: true`, `pattern: '^ctx7sk-[A-Za-z0-9_-]{16,128}$'` ⚠ — the documented format is `ctx7sk-**********************`; **(live)** a real key is 43 characters; the character set after the prefix is not documented (D6)                                |
| `help`                        | "Create a key in the Context7 dashboard, API Keys. A key reaches what its teamspace's policies allow; the key itself has no permission choice. The questions agents ask are counted on the plan of the person who created it."                                               |
| `guide.permissions`           | `[]` — a Context7 key carries no permission choice (none is documented)                                                                                                                                                                                                      |
| `guide.recommendedExpiryDays` | `null` — no expiry is documented; "Keys can be rotated at any time from your dashboard"                                                                                                                                                                                      |
| `verify`                      | `GET https://context7.com/api/v2/usage` with `Authorization: Bearer <key>`. 200 → `{ account: 'Context7 <plan> plan', expiresAt: null }` (`plan` is `free`, `pro`, `enterprise` or `payg`). 401 or 403 → `UpstreamAuthError`, nothing stored. Free: the call is not counted. |
| `manualRevocation`            | "Revoke the key in the Context7 dashboard, API Keys. Revocation is immediate and permanent."                                                                                                                                                                                 |

Facts behind it: keys are shown once at creation; "Revoking a key is
permanent and cannot be undone. The key deactivates immediately"; keys are
"hashed and encrypted" at Context7; they belong to a teamspace (policies
apply to "the teamspace's API keys") and usage is counted on the key's
owner (`member.requests` against `includedInPlan`). No revocation endpoint
is documented, so no `revoke`.

No `oauth2` way in v0.1, although the server offers one (`/mcp/oauth`, "the
MCP OAuth specification"; the Claude Code plugin signs in by device flow):
it is an MCP-client OAuth with dynamic registration, the Supabase shape the
gateway does not forward server-side, and a key is what "zero env" needs
(D7).

**Header.** The documented way is `Authorization: Bearer <key>` (README,
"Manage API Keys", "All MCP clients" — Cursor, VS Code, Codex, Gemini CLI…),
and **(live)** it works on `https://mcp.context7.com/mcp`. The server also
reads `x-context7-api-key`, `context7-api-key`, `x-api-key`,
`context7_api_key` and `x_api_key` (source ⚠); a `CONTEXT7_API_KEY` header
was accepted too. The plugin sends `Authorization: Bearer` only, to the MCP
server and to the REST API alike (decided, D8).

### 6.2 Discovery

`discoverResources` calls `GET /api/v2/usage` (free) and returns one
resource:

```ts
[{ provider: 'context7', ref: 'docs', displayName: 'Context7 library index', metadata: { plan } }];
```

`plan` is checked against the four documented values by a type guard; an
unknown value or payload fails the discovery. No `env`. The ref is a
constant because nothing in Context7's answers identifies the teamspace;
two connections with two keys each have their own `docs` resource.

### 6.3 Execution

`executeContext7(ctx, tool, args)`, under `declining`:

1. the call is read by the classifier's `readCall`: an unknown tool, an
   undeclared argument, or a `libraryId`, `libraryName`, `query` or
   `language` outside its grammar → `refusalResult` with the classifier's
   own sentence. Nothing is sent;
2. the single resource is resolved by the classifier's function (a mission
   without one is declined);
3. JSON-RPC `tools/call` to `https://mcp.context7.com/mcp` (a constant),
   the `context7__` prefix stripped, the arguments rebuilt from the
   classifier's reader (`libraryId` as the grammar returned it), headers
   `Authorization: Bearer <key>`, `Accept: application/json,
text/event-stream`, `MCP-Protocol-Version` as Railway sends it, a
   `User-Agent: vaubaan-gateway`. The SSE frame (or bare JSON) is parsed
   and the MCP result passed through when it is not an error.

Failures:

| What happens                                                | The plugin                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 401 / 403 from the MCP server (JSON-RPC `-32001`)      | `UpstreamAuthError` with the status                                                                                                                                                                                                                                                                                                                                                         |
| another failed HTTP status                                  | `UpstreamHttpError` with the status                                                                                                                                                                                                                                                                                                                                                         |
| a JSON-RPC error frame, or a result that is not text blocks | a plain `Error`                                                                                                                                                                                                                                                                                                                                                                             |
| a tool result with `isError: true` (Context7's REST failed) | probe `GET /api/v2/usage`: 401 or 403 → `UpstreamAuthError` with that status (the key is refused: the host marks the connection expired on a 401); 429 → `UpstreamHttpError(429)`; 200 or any other status → a plain `Error` carrying Context7's text (quota spent, library not found, 402, 5xx) — the agent reads it, the audit keeps the class; probe unreachable → the plain `Error` too |

The upstream text is not parsed to decide anything; at most 300 characters
of it are quoted in the error. A probe after an upstream error costs nothing
on Context7's quota. A result with `isError: false` (or none) is passed
through as its `content`, "No documentation found" included.

No streaming (`emitPart` unused), no `credentialCache`, no `refresh`.

### 6.4 Code map

| File                      | What it holds                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/identity.ts`         | `PROVIDER_ID`, `TOOL`, `UPSTREAM_TOOL`, `INDEX_REF`, `API_KEY_FIELD`: the one place ids are written.             |
| `src/upstream-tools.json` | The `tools` array of `tools/list`, verbatim (2026-10-16).                                                        |
| `src/tools.ts`            | The declarations derived from it (prefixed names, a modelled-tools check at load) and `toolTitles`.              |
| `src/data-model.ts`       | The `docs` plane (§1).                                                                                           |
| `src/risk-catalog.yaml`   | §3.                                                                                                              |
| `src/classify.ts`         | `readCall` (the one reader, shared with `execute`), `libraryId`, `freeText`, `resolveIndex`, `classifyContext7`. |
| `src/usage.ts`            | `GET /v2/usage`: the key of a connection, `readPlan` (verify, discovery), the probe's request.                   |
| `src/credential.ts`       | The `api-key` spec, its guide and `verifyContext7Key`.                                                           |
| `src/execute.ts`          | `executeContext7` (JSON-RPC over Streamable HTTP, the probe on a tool error), `discoverContext7Resources`.       |
| `src/index.ts`            | `definePlugin`, the default export.                                                                              |

### 6.5 Tests

`npx vitest run plugins/context7` — 46 tests, no network
(`tests/unit/support.ts` holds the shared context and the upstream answers
as the live calls showed them):

- `plugin.test.ts` (12): the kit — `assertPluginWellFormed`,
  `assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage` with the
  samples of §4 (`fallbackHits` and `risksUntouched` empty),
  `assertIdentifiersRefused` with `pathIdentifiers: { none: … }`; the
  catalog path, the default export and the version; the credential spec and
  its pattern; the preset's exact budget; no environment anywhere; the
  frozen surface (exactly the two tools of `tools/list`, descriptions and
  schemas unchanged, the schemas checked live, no alias declared, a title
  per tool);
- `classify.test.ts` (10): each tool, the `@` and `+` forms on `[*]`, the
  only risk touched, an unknown tool, no or a foreign resource, a resource
  that is not the index or several, every alias and an invented argument
  denied, 25 malformed library ids, the free-text bounds (500 accepted, 501
  refused);
- `execute.test.ts` (17): the JSON-RPC body (prefix stripped, arguments as
  classified, nothing else) and the headers (Bearer, no other key header),
  SSE and bare JSON answers, refusals with `fetch.calls` empty, the hostile
  library ids fed to `classify` and `execute`, an accepted id sent
  unchanged, a credential without its key, HTTP 401 / 403 / 503, a JSON-RPC
  error frame, a result that is not text, the probe's answers (401, 429,
  200, 500, unreachable), "No documentation found" passed through;
  `discoverResources` and `verify` on 200 (each plan), 401, 503 and four
  answers that are not the documented one;
- `risk-catalog.test.ts` (5): the entries at catalog version 1, the decided
  vector, every pattern parsing, a read of the index (a search or one
  library) touching `context7.query-docs` alone, a write no tool emits
  landing on the fallback alone;
- `data-model.test.ts` (2): referential integrity, the one plane with
  nothing environment-scoped.

## 7. This repository afterwards (`.mcp.json`)

`.mcp.json` is not edited by the plugin's change. Once a Context7
connection exists on the dogfood instance:

1. the `context7` entry is removed from `.mcp.json` — no direct server, no
   key anywhere in the file;
2. the mission behind the existing `vaubaan` server's token adds the
   Context7 connection, its `docs` resource and `context7.query-docs`
   (preset `read-only`); the token does not change;
3. the tools then appear under the `vaubaan` server, as
   `mcp__vaubaan__context7__resolve-library-id` and
   `mcp__vaubaan__context7__query-docs` in Claude Code.

The docs were updated with the registration: the provider-modeler skill and
the ADR `use-context7-for-provider-docs` (an amendment of 2026-10-16) say that
Context7 is reached through the gateway, as `mcp__vaubaan__context7__…`,
once the dogfood instance has the connection. The direct server's MCP
`instructions` ("Use this server to fetch current documentation whenever…")
do not travel through the gateway, which has its own; the tool descriptions
keep Context7's usage rules.

## Decisions of the product owner (2026-10-16)

The model above was reviewed by Renaud on 2026-10-16. What he decided, by
the number of the question the draft asked; every other proposal of the
draft stands as written.

- **Shape (§0).** Rewrap `https://mcp.context7.com/mcp`, the Railway shape;
  the REST API (`GET https://context7.com/api/v2/usage`) only for checking a
  pasted key, discovery and diagnosing an upstream error.
- **No environment anywhere** (§1): no `envScopable` entity, no `envOf`, no
  env-scoped risk.
- **D1 — one preset**, `read-only` (quota 300, 20 calls per 60 s, `auto`),
  which is also the daily-work preset.
- **D2 — one risk**, `context7.query-docs`, for both tools, plus the
  fallback.
- **D3 — private sources**: out of v0.1.
- **D4 — vector**: as drafted (`visibility: public`, `reversibility:
irreversible`).
- **D5 — query text**: not inspected.
- **D6 — key pattern**: the loose `^ctx7sk-[A-Za-z0-9_-]{16,128}$`.
- **D7 — OAuth**: none; an API key only.
- **D8 — header**: `Authorization: Bearer`.
- **Q9 — plan of the dogfood key**: not decided here; it changes no code.
  On a paid plan, set a spending limit in the teamspace: the gateway's quota
  bounds a mission, not the key.
- **Q10 — facts checked by live calls on 2026-10-16** (marked **(live)**
  above): `tools/list` returns exactly `resolve-library-id` (`query`,
  `libraryName`, both required) and `query-docs` (`libraryId`, `query`
  required; `language` optional); `Authorization: Bearer <key>` works; a bad
  key answers HTTP 200 with an `isError` result "Invalid API key. …" in an
  SSE `event: message` frame; `GET /api/v2/usage` with a bad Bearer key
  answers HTTP 401.
- **Goal: everything through the gateway, zero env.** The key exists only
  as a gateway connection. `.mcp.json` is not edited by the plugin's change
  (§7); the provider-modeler skill and the ADR
  `use-context7-for-provider-docs` (by an amendment) name the gateway tools
  `mcp__vaubaan__context7__…` once the dogfood instance has the connection.

## Sources

Fetched with `WebFetch` on 2026-10-16, under the exception stated at the top
(Context7's own MCP quota exhausted; official Context7 sources only):

- <https://github.com/upstash/context7> — README: remote URL, `Authorization:
Bearer`, the two tools and their parameters, library id examples.
- <https://raw.githubusercontent.com/upstash/context7/master/packages/mcp/src/index.ts>
  — tool schemas, descriptions, annotations, aliases, accepted key headers,
  `/mcp` and `/mcp/oauth`, stateless server, `isError` on `outcome === "error"`.
- <https://raw.githubusercontent.com/upstash/context7/master/packages/mcp/src/lib/tool-names.ts>
  — the two tool-name constants.
- <https://raw.githubusercontent.com/upstash/context7/master/packages/mcp/src/lib/api.ts>
  — REST endpoints called, error texts of `parseErrorResponse`.
- <https://context7.com/docs> and <https://context7.com/docs/llms.txt> — the
  documentation index.
- <https://context7.com/docs/howto/api-keys.md> — `ctx7sk-` format, shown
  once, revocation immediate and permanent, Bearer header.
- <https://context7.com/docs/api-guide.md> — authentication, `ctx7sk`
  prefix, error codes, rate-limit headers, endpoints, caching advice.
- <https://context7.com/docs/api-reference/context/get-documentation-context.md>
  — `GET /v2/context` parameters, version forms of a library id, limits.
- <https://context7.com/docs/api-reference/search/search-for-libraries.md>
  — `GET /v2/libs/search` parameters and response.
- <https://context7.com/docs/api-reference/usage/get-api-usage.md> —
  `GET /v2/usage`, not counted, plan and usage fields.
- <https://context7.com/docs/api-reference/policies/get-teamspace-policies.md>
  — no teamspace id in the answer.
- <https://context7.com/docs/howto/private-sources.md> — Pro or Enterprise
  plan, roles.
- <https://context7.com/docs/howto/teamspace.md> — roles, members per plan.
- <https://context7.com/docs/howto/policies.md> — policies apply to every
  request made with the teamspace's keys.
- <https://context7.com/docs/howto/usage.md> — usage counting, resets.
- <https://context7.com/plans> — calls per month per plan, overage.
- <https://context7.com/docs/security/data-privacy.md> — what the client
  sends, queries stored, logs 30 days.
- <https://context7.com/docs/security/auth-and-access-control.md> — keys
  hashed and encrypted, rotation.
- <https://context7.com/docs/clients/claude-code.md> and
  <https://context7.com/docs/resources/all-clients.md> — headers per
  client, `/mcp/oauth`.

Live check by the coordinator, 2026-10-16: `CONTEXT7_API_KEY` header
accepted by `https://mcp.context7.com/mcp`; a 43-character `ctx7sk-…` key;
`resolve-library-id` answered as an SSE `event: message`.

Repository side, read directly: `plugins/README.md`, `plugins/_template/`,
`docs/handbook/plugin-sdk.md`, `docs/spec/gateway-risk-model.md` §2–4 and
§7, `docs/handbook/providers/railway.md`,
`docs/handbook/providers/upstash-redis.md`,
`docs/handbook/threat-model.md` ("A compromised or hostile provider"), and
the ADRs linked above.
