---
title: Railway plugin
tracks:
  - plugins/railway/src/
  - plugins/railway/README.md
last_reviewed: 2026-11-20
---

# Railway plugin — handbook

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
- `P` is `projectId` if it names a mission resource by its ref **or its exact display name** (the
  Railway project name; no case folding, no prefix), else the single Railway project, else the
  project whose environments contain `environmentId`, else denied. The request always carries `P`'s
  id, never the name given. A name two mission projects share is refused (ask for the id).
- `locateProject` (via `resolveTarget`) is the one resolver for classify and execute: a lookup added
  on one side only sends a project the slices did not name.
- Every refusal of a target names the mission's projects as `name (id)`, ten at most, and points to
  `list-projects`: the agent must be able to act on it without guessing.
- **`list-projects` never reaches Railway**: it answers the mission's projects from `ctx.resources`
  (id, name, owner label, environments, services). Railway's answer is free text over every project
  the token sees; filtering it would trust its format to keep the others out. A project created
  after discovery shows up once it is a resource (created hook or refresh).
- Two schemas: the declared one (what the agent reads) gives every project-scoped tool a `projectId`
  (`accept-deploy` gains one for routing); the forward one (frozen upstream, custom tools' own)
  decides where the resolved id is sent (`forwardTakesProjectId`). Deriving the forward set from the
  declared schemas would send `projectId` to `accept-deploy`, whose upstream schema is closed.
- Account-level tools (`whoami`, `list-projects`, `create-project`) declare no `projectId`: one
  given there is refused as undeclared, never forwarded unread.
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

- `projectId: argument required — the mission touches N Railway projects` → several projects, no
  `projectId`, no `environmentId`; the refusal lists them.
- `environmentId: not an environment of a Railway project of this mission as last discovered` →
  several projects and an `environmentId` found in none: another project's, or created after
  discovery (refresh resources).
- `projectId: N Railway projects of this mission are named '…'` → duplicate names (e.g. across
  workspaces); pass the id.
- `not an environment/service of railway project` → another project's, or created after discovery
  (refresh); `… are unknown` → resource predates the metadata field (refresh once).
- `risk-not-accepted` with hint "no environment label" → the owner labels the project; naming
  `bulk-variables-replace` → `replace` set, empty `variables`, or a `railway-agent` call.
- `UpstreamAuthError` on every call → token deleted at Railway, or an account made through the
  Railway Auth app of an earlier build: reconnect with a token.
