---
title: Context7 provider plugin
tracks:
  - plugins/context7/src/
last_reviewed: 2026-10-27
---

# Context7 provider plugin — handbook

`@vaubaan/plugin-context7`: Context7's two documentation tools (`resolve-library-id`,
`query-docs`) under a mission, with no key in an env variable or `.mcp.json`. A rewrap of
`https://mcp.context7.com/mcp` for the tools, the REST API (`https://context7.com/api`) for the
rest ([rewrap-official-mcps](../../decisions/rewrap-official-mcps.md)). Rules common to every
plugin: [providers README](README.md).

## Start here

- [`src/classify.ts`](../../../plugins/context7/src/classify.ts) — `readCall`, the one reader.
- [`src/execute.ts`](../../../plugins/context7/src/execute.ts) — JSON-RPC call, error probe,
  discovery.
- [`src/usage.ts`](../../../plugins/context7/src/usage.ts) — the usage endpoint, `isQuotaSpent`.
- [`src/upstream-tools.json`](../../../plugins/context7/src/upstream-tools.json) — the verbatim
  `tools/list`; a tool Context7 adds later is refused until modelled.

## Invariants

- One resource per account, constant ref `docs`: no REST answer names the teamspace. `library`
  stays an entity so the audit names the library read; `resolve-library-id` is always `[*]`.
- One risk for both tools, with the vector of a documentation read (`reversible`, `single`,
  `data`, `free`, `internal`: row 1, harmless). The disclosure of the agent's free text to a
  third party that keeps queries 30 days is said in the reason and the narrative; until
  2026-11-13 the vector priced it as `irreversible`, which put a read in "Cannot be repaired".
- No identifier reaches a URL (one `POST` to a constant URL), so the identifier proof runs with
  `pathIdentifiers: { none }`; `libraryId` still has a grammar because it lands in a slice.
- The gateway does not check that a library exists or that the key may read it: teamspace policies
  decide, Context7 answers 404/403.

## Traps

- **Failures arrive as tool results on HTTP 200** (`isError: true`): a bad key answers 200 "Invalid
  API key" while `GET /api/v2/usage` answers 401. The executor never parses the text: it probes the
  usage endpoint (401/403 → `UpstreamAuthError`; 429 or quota provably spent →
  `UpstreamHttpError(429)`; else a plain `Error` quoting at most 300 characters).
- **The server accepts argument aliases** its schema does not declare (`userQuery`, `question`,
  `libraryID`, `libraryName` on `query-docs`…): an alias would carry a library past the classifier,
  so the closed surface refuses them. A test pins each one.
- Quota provably spent: Free plan with `requests >= includedInPlan`, or a teamspace spending limit
  reached. A paid plan past its included requests is billed overage, not blocked.
- The server is stateless: no `initialize`, the key is a header on each request, the answer is an
  SSE frame. If it ever becomes stateful or changes auth, fall back to REST alone.
- The MCP client is the SDK's (`CONTEXT7_MCP_SERVER`, `session: 'never'`: the server is stateless).
- Left out on purpose: adding libraries (sends company content) and `PATCH /v2/policies` (changes
  what every key of the teamspace reaches).

## Outside the repo

- Key created at `https://context7.com/dashboard`, API Keys: no permission choice, no documented
  expiry, no revocation endpoint (revocation in the dashboard is immediate).
- The key's quota is shared by every mission and any other use: on a paid plan, set a spending
  limit in the teamspace; recommend its library filter (verified libraries, minimum trust score)
  against look-alike ids.
- Upstream facts come from live calls (2026-10-16) and the open-source server
  `github.com/upstash/context7`, assumed to be the hosted one.

## Debug

- `libraryId: malformed Context7 library id.` → a leading `/`, 1 to 4 segments, no `..`.
- A `query-docs` refused for an argument → an upstream alias; use `libraryId` and `query`.
