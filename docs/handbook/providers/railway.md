---
title: Railway provider plugin
tracks:
  - plugins/railway/src/
  - plugins/railway/README.md
last_reviewed: 2026-10-27
---

# Railway provider plugin — handbook

`@vaubaan/plugin-railway` rewraps Railway's MCP server (`mcp.railway.com`, tools frozen in
`src/upstream-tools.json`, [ADR](../../decisions/rewrap-official-mcps.md)) and adds GraphQL variable
tools. Resource: the Railway project.

## Start here

- [`src/classify.ts`](../../../plugins/railway/src/classify.ts) — pure, security-critical:
  `resolveTarget` alone decides project, environment and service; `readVariableWrite`; the id
  grammars.
- [`src/execute.ts`](../../../plugins/railway/src/execute.ts) — `pinTarget` rewrites the target from
  the resolved call, never from the arguments.
- [`src/credential.ts`](../../../plugins/railway/src/credential.ts) — token check at paste,
  `explainMcpRefusal`.
- [`src/custom-tools.ts`](../../../plugins/railway/src/custom-tools.ts) — the GraphQL variable
  tools.

## Invariants

- **Every forwarded id is bound to the mission's project `P`**: the token reaches every project of
  the workspace. `environmentId` must be in `metadata.environments` of `P`, `serviceId` in
  `metadata.services`. A resource with no list (older discovery) is denied until refreshed, never
  read as "no service".
- `P` is `projectId` if a mission resource, else the single Railway project, else the project whose
  environments contain `environmentId` (the only way for `accept-deploy`), else denied.
- **Ids that cannot be bound are refused** and left out of the schema (`UNBOUND_ARGUMENTS`):
  `deploymentId` and the agent tool's `threadId`. `get-logs` reads the latest deployment of a bound
  service; every `railway-agent` call starts a new conversation. A test checks no other id-like
  argument is left unbound.
- Undeclared arguments are denied in classify and execute
  ([ADR](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)); `projectId`
  is rewritten only where the schema takes it. Ids travel as JSON-RPC arguments or GraphQL variables
  of a constant document, never a URL.
- `bulk-variables-replace` matches only the `service-var-replace.W` marker, emitted when `replace`
  is anything but absent or `false` (a non-boolean is not trusted to mean "no"), when `variables` is
  empty or not an object, and always by `railway-agent`.
- `railway-agent` is unbound (`unboundTools`): unavailable on an account that sees the gateway's own
  project (`RAILWAY_PROJECT_ID`), since free text cannot be held to the mission's projects.

## Traps

- **One owner label covers the whole project**, whatever Railway environment `environmentId` names:
  label by the most sensitive environment, or keep production in its own project.
- An unlabelled project (or a label outside `prod` / `staging` / `preview` / `dev`) refuses the
  env-scoped operations for every mission; only the owner's label fixes it, not a new mission.
- The created-project hook trusts an undocumented answer: exactly one object whose `id` passes the
  grammar and whose `name` is the one asked; otherwise the project waits for discovery. One created
  by `railway-agent` always waits for a refresh.
- `User-Agent` is always `vaubaan-gateway`: Cloudflare in front of the MCP server refuses some
  defaults (error 1010).
- On an MCP auth failure the token is probed on the GraphQL API: refused there → 401 (rejected
  credential); accepted → 403 "not permitted", so a healthy account is not marked expired.

## Outside the repo

- A **workspace token** (Account settings → Tokens, one workspace, recommended) or an account token
  ("No workspace": every workspace). Project tokens are not accepted (one environment of one
  project). No scope, no expiry exposed; removal is by hand on the same page.
- Railway documents its MCP server for OAuth and CLI sign-in only; the workspace token was checked
  against it (2026-10-14), the account token not.

## Debug

- `ambiguous railway target: specify projectId.` → several projects and no known `environmentId`;
  refresh resources if the environment is new.
- `not an environment/service of railway project` → another project's, or created after discovery
  (refresh); `… are unknown` → resource predates the metadata field (refresh once).
- `risk-not-accepted` with hint "no environment label" → the owner labels the project; naming
  `bulk-variables-replace` → `replace` set, empty `variables`, or a `railway-agent` call.
- `UpstreamAuthError` on every call → token deleted at Railway, or an account made through the
  Railway Auth app of an earlier build: reconnect with a token.
