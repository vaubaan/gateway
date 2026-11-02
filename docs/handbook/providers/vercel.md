---
title: Vercel provider plugin
tracks:
  - plugins/vercel/src/
  - plugins/vercel/README.md
last_reviewed: 2026-11-02
---

# Vercel provider plugin — handbook

`@vaubaan/plugin-vercel` rewraps Vercel's MCP server (`mcp.vercel.com`, tools frozen in
`src/upstream-tools.json`) and adds REST tools ([ADR](../../decisions/rewrap-official-mcps.md)).
Resource: the project; the environment is a slice segment, not a resource label.

## Start here

- [`src/classify.ts`](../../../plugins/vercel/src/classify.ts) — `resolveProject`, the id grammars,
  `readDeploymentTargets`, `vercelEnvOf`, `UNBOUND_TOOLS`.
- [`src/execute.ts`](../../../plugins/vercel/src/execute.ts) — `pinArgs`, `bindDeployments`.
- [`src/redact.ts`](../../../plugins/vercel/src/redact.ts) and
  [`src/project-redact.ts`](../../../plugins/vercel/src/project-redact.ts) — redaction of metadata
  reads.

## Invariants

- **Environment axis**: the project spans three environments, so the owner's label is meaningless;
  the plugin declares `envOf` (`vercelEnvOf`), asked before the label
  ([plugin SDK](../plugin-sdk.md)). An `env` segment followed by anything but one triad label
  (`env[*]`, `env[staging]`) answers `NO_SINGLE_ENV`: every env-scoped risk refused, so a
  multi-env write cannot fail open. A host resolving from the label alone would qualify every
  preview deploy as prod.
- **Slices walk the data model**: deployments and env vars sit under `env` (`project[p].env[e].…`).
  The deployment, log and env-var reads and the bypass-token mint do not know their environment and
  emit `env[*]` (`get_runtime_logs` names it when its `environment` filter does). No env-scoped risk
  matches those slices, so their `NO_SINGLE_ENV` changes no decision: keep it so (a test checks every
  sample); the catalog's `project[**]` patterns match with or without the `env` segment.
- **The team is pinned to the credential**: a `teamId` argument other than the credential's is
  refused on every tool; the sent value always comes from the credential. Rewrapped tools that
  cannot carry it (`TEAMLESS_UPSTREAM_TOOLS`) are forwarded only when they read no team data or
  after their deployment is resolved under the pinned team; any other teamless tool is refused
  (`tests/unit/team-pin.test.ts` checks the list against the schemas).
- **Deployment binding**: a rewrapped tool declaring `idOrUrl`, `deploymentId` or `url` is forwarded
  only after `GET /v13/deployments/{…}?teamId=<pinned>` returns the resolved project. A 404, 403, an
  answer without `projectId` (a foreign deployment's reduced view) or another project is a refusal;
  ids are replaced by the verified id and `url` re-serialised. The deployment slice segment is not
  proof of ownership.
- Thread-addressed toolbar tools are denied (`UNBOUND_TOOLS`): no lookup ties a thread to a project,
  so they could act on any thread of the team. Re-enabling needs a verified thread → project lookup.
- Rewrapped tools forward their arguments whole, so undeclared arguments are denied in classify and
  again in execute; another spelling is another argument (`project_id`). `teamId` / `projectId` are
  rewritten, never forwarded as given.
- An unreadable env-var `target` (non-array, `prod`, `Production`) is refused, never classified on
  its readable part. `delete_env_var` always touches the three environments: Vercel removes the
  variable everywhere.
- Ids are re-read with the classifier's grammars and interpolated as they are, never escaped
  (`encodeURIComponent` leaves `..`;
  [ADR](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)).
- Metadata reads are redacted by allow-list: env-var values without `decrypt=true`, and project
  answers (they carry `env[]` values and deploy-hook URLs, which trigger deploys). Non-JSON text is
  replaced whole.

## Traps

- `deploy_to_vercel` is always classified `prod`: upstream declares no `target`, and deploys "the
  current project" from CLI context; whether it honours the pinned team and project is not verified.
- `get_access_to_vercel_url` mints a bypass token: a credential write, not a read.
- `vercel.toolbar-write` and the non-prod qualifications of `vercel.deploy` are reached by no tool;
  risk ids are stable, so they stay.
- Deployment Protection (SSO / password) cannot be changed with an API token.
- `disconnect_git` (`DELETE /v9/projects/{id}/link`) is classified `project-settings.W`, like
  `update_project_settings`: no Git-triggered build afterwards. Vercel answers with the project
  object; the tool drops it and answers `{ ok: true, projectId }`. Relinking has no tool: the
  Vercel dashboard.
- `next build` fails with `The "path" argument must be of type string … Received an instance of URL`
  → Turbopack rewrites `new URL(…, import.meta.url)`; keep `catalogPathNextTo`.

## Outside the repo

- An API token (Scope: the team, All Projects) plus its `team_id` (`team_…`). Checked at paste:
  `GET /v5/user/tokens/current` gives the expiry, `GET /v2/teams/{id}` names the team; a
  project-scoped token or a wrong Team ID (403/404 there) is refused at paste.

## Debug

- `deployment '…' does not belong to vercel project '…'` → pass the right `projectId`;
  `could not be verified` → another team, deleted, or a custom domain: use the deployment id or its
  `*.vercel.app` URL.
- `teamId is fixed by the connection` → omit `teamId`.
- `get_firewall_config` or `deploy_to_vercel` refused on a mission without `watch`, or without
  `vercel[prod].deploy` → by design: the mission holds no such line.
