# Vaubaan Agent Bootstrap

> Self-contained reference for an LLM (or any MCP client) that has been
> handed a `vbn_live_*` access token and needs to do useful work through the
> Vaubaan gateway.

---

## 1. What you have

A **`vbn_live_*` access token**. It is:

- Scoped to **one Project** in a Vaubaan organization.
- Bound to a set of **roles** that the operator (or CAR) attached at mint time.
- Honest about its TTL — once `expires_at` passes, calls return `401`.

Treat it like a password: never log it, never commit it. The runner that
spawned you keeps it in memory only.

## 2. Endpoint and auth

|              |                                      |
| ------------ | ------------------------------------ |
| Base URL     | `https://vaubaan.com/mcp`            |
| Method       | `POST` (JSON-RPC 2.0)                |
| Auth         | `Authorization: Bearer <vbn_live_…>` |
| Content-Type | `application/json`                   |

The gateway is **stateless per Bearer**: every request authenticates
independently, there is no `Mcp-Session-Id` to manage, and an `initialize`
handshake is not required before `tools/call`.

## 3. Minimal probes

### 3.1 Who am I (what can I do) ?

```bash
curl -sS https://vaubaan.com/mcp \
  -H "Authorization: Bearer $VBN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response only includes the tools your roles **could** call. If a tool you
expect is missing, either:

- your token's roles don't allow it, or
- the corresponding provider isn't connected on the organization yet.

### 3.2 Initialize (optional, for clients that need it)

```bash
curl -sS https://vaubaan.com/mcp \
  -H "Authorization: Bearer $VBN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-agent","version":"0.1.0"}}}'
```

## 4. The call shape

Every action is a `tools/call`:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "<provider>__<verb>_<noun>",
    "arguments": {
      /* …per inputSchema in tools/list… */
    }
  }
}
```

Successful response (`result.content[0].text` is JSON-encoded payload):

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "content": [{ "type": "text", "text": "{...JSON payload...}" }],
    "isError": false
  }
}
```

Denied response (JSON-RPC error):

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32603,
    "message": "Vaubaan policy denied: <reason>"
  }
}
```

## 5. Tool catalog

Tool names follow `<provider>__<verb>_<noun>` (double underscore between
provider and verb). The exhaustive list lives in `tools/list` — below is the
high-level map.

### 5.1 GitHub (`github__…`)

| Tool                                                                 | Purpose                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `github__list_branches` / `_commits` / `_pull_requests` / `_issues`  | Read lists.                                                                               |
| `github__get_file_contents` / `_pull_request` / `_issue` / `_commit` | Read singles.                                                                             |
| `github__search_code` / `_search_issues`                             | Search.                                                                                   |
| `github__create_branch`                                              | Create a branch (constrained to `feature/*`, `fix/*`, `claude/*` for `github:developer`). |
| `github__create_or_update_file` / `_push_files`                      | Write files on an allowed branch.                                                         |
| `github__create_pull_request`                                        | Open a PR (must target `main` for `github:developer`).                                    |
| `github__add_issue_comment`                                          | Comment on issues/PRs.                                                                    |
| `github__mint_install_token`                                         | **Mint a short-lived `ghs_*` install token** scoped to the Project repos — see §6.1.      |
| `github__merge_pull_request` / `_delete_file`                        | Dangerous — deny-listed by default.                                                       |

### 5.2 Vercel (`vercel__…`)

Rewrap of `mcp.vercel.com` — 18 tools. Common ones :

- `vercel__list_projects`, `vercel__get_project`, `vercel__list_deployments`
- `vercel__get_deployment`, `vercel__get_deployment_build_logs`
- `vercel__get_deployment_runtime_logs`
- `vercel__list_env_vars`, `vercel__get_env_var`
- `vercel__create_deployment` (where allowed by role)

The gateway auto-fills `teamId` from the connected admin and `projectId`
from the project's Vercel binding — you usually don't need to pass them.

### 5.3 Supabase (`supabase__…`)

Synthesis over the Management API (`api.supabase.com/v1`). Common ones :

- `supabase__list_projects`, `supabase__get_project`
- `supabase__list_tables`, `supabase__get_table`
- `supabase__list_migrations`, `supabase__list_advisors`
- `supabase__execute_sql` (SELECT-style for read roles)

`project_ref` is auto-filled from the project's Supabase binding.

### 5.4 Railway (`railway__…`)

Rewrap of `mcp.railway.com` — 10 tools. Tool names use kebab-case after the
prefix (`railway__list-projects`, not `railway__list_projects`).

| Tool                                                    | Purpose                                              |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `railway__whoami`                                       | Identity check.                                      |
| `railway__list-projects` / `-services` / `-deployments` | Read.                                                |
| `railway__get-status` / `-logs`                         | Read deploy + runtime data.                          |
| `railway__create-project`                               | Provision a new project.                             |
| `railway__redeploy`                                     | Re-deploy a service.                                 |
| `railway__railway-agent`                                | Hand a multi-step infra task to Railway's own agent. |
| `railway__accept-deploy`                                | **DESTRUCTIVE** — denied by `railway:member`.        |

`projectId` is auto-filled from the project's Railway binding when there is
exactly one.

## 6. Recipes

### 6.1 Bootstrap a coding session (CAR + agent split)

The Vaubaan model is: **no git credentials on the runner VPS**. Both `clone`
and `push` ask the gateway for a short-lived (1h) GitHub App install token.

#### CAR — at session boot (role `github:provisioner`)

```bash
RES=$(curl -sS https://vaubaan.com/mcp \
  -H "Authorization: Bearer $VBN_PROVISIONER" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"github__mint_install_token",
                 "arguments":{"purpose":"clone","repoFullName":"acme/website"}}}')

TOKEN=$(echo "$RES" | jq -r '.result.content[0].text | fromjson | .token')
git clone "https://x-access-token:${TOKEN}@github.com/acme/website.git"
```

`purpose: "clone"` → the minted token only has `contents: read`. After clone
discard it; the next push uses a fresh token.

#### Agent — when ready to push (role `github:developer`)

```bash
RES=$(curl -sS https://vaubaan.com/mcp \
  -H "Authorization: Bearer $VBN_DEV" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"github__mint_install_token",
                 "arguments":{"purpose":"push","repoFullName":"acme/website"}}}')

TOKEN=$(echo "$RES" | jq -r '.result.content[0].text | fromjson | .token')
git -c credential.helper= -c "http.https://github.com/.extraheader=AUTHORIZATION: bearer $TOKEN" \
    push origin claude/my-feature
```

`purpose: "push"` → the minted token gets `contents: write` +
`pull_requests: write` + `metadata: read`. Enough for `git push` and to open
a PR via `github__create_pull_request` afterwards.

#### Open the PR through MCP (no extra credential needed)

```bash
curl -sS https://vaubaan.com/mcp \
  -H "Authorization: Bearer $VBN_DEV" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"github__create_pull_request",
                 "arguments":{"owner":"acme","repo":"website",
                              "title":"Feature: …",
                              "head":"claude/my-feature",
                              "base":"main"}}}'
```

### 6.2 Check the latest deploy of a Vercel project

```bash
curl -sS https://vaubaan.com/mcp \
  -H "Authorization: Bearer $VBN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"vercel__list_deployments","arguments":{}}}'
```

`projectId` and `teamId` are auto-injected from the binding ; no need to
pass them.

### 6.3 Trigger a Railway redeploy

```bash
curl -sS https://vaubaan.com/mcp \
  -H "Authorization: Bearer $VBN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"railway__redeploy",
                 "arguments":{"environmentId":"<env-uuid>","serviceId":"<svc-uuid>"}}}'
```

`projectId` is auto-injected. `environmentId` and `serviceId` come from a
previous `railway__list-services` call.

### 6.4 Run a read-only SQL query on a Supabase project

```bash
curl -sS https://vaubaan.com/mcp \
  -H "Authorization: Bearer $VBN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"supabase__execute_sql",
                 "arguments":{"query":"select count(*) from orders;"}}}'
```

`project_ref` is auto-injected. Roles like `supabase:reader` only allow
SELECT-style queries — DDL will be denied with a clear policy message.

## 7. Error model — read the messages

The gateway is intentionally verbose on failures. Common ones :

| Error message starts with                            | What it means                                                                                     | What to do                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Vaubaan policy denied: …`                           | Your roles don't allow this tool or the constraints failed (e.g. wrong branch name, missing arg). | Read the rest of the message — it names the matched rule. Adjust args or ask for a different role. |
| `tool '…' does not match any supported provider …`   | Typo in the tool name.                                                                            | Hit `tools/list` to re-check the exact name.                                                       |
| `provider 'X' is not connected for organization '…'` | The operator hasn't connected provider X to the org yet.                                          | Tell the operator. You cannot self-serve.                                                          |
| `access token has expired.`                          | Your `vbn_live_*` is past its TTL.                                                                | Ask for a fresh one. CAR usually rotates automatically.                                            |
| `Upstream call failed: …`                            | Provider API rejected the call (network, scope, repo not found…).                                 | Read the upstream payload echoed in the message ; usually it tells you exactly what's wrong.       |

## 8. Conventions and gotchas

- **Resource refs** : `<owner>/<repo>` for github, `prj_…` for vercel,
  20-char project ref for supabase, UUID for railway. These are stored as
  bindings on the Project.
- **Scope auto-injection** : when the Project has exactly one binding for a
  given provider, the gateway strips the resource identifier from the
  `tools/list` schema **and** auto-fills it at call time. Caller-provided
  values win, so an admin can still override.
- **Audit** : every call you make produces an `audit_log` row
  (org, project, access_token, tool, args hash, decision, role matched,
  latency). Operators can replay it.
- **Idempotency** : MCP `tools/call` is **not** automatically idempotent.
  If your retry pushes a commit twice, you get two commits. Use
  `github__list_commits` to check state before retrying writes.
- **`accept-deploy` is DESTRUCTIVE** : on Railway, the upstream itself flags
  it. Builtin roles deny it by default. Do not call it without an explicit
  human confirmation.

## 9. Asking for more

- Need a tool that isn't here ? Ask the operator. They can extend roles or
  bind new resources, but the **set of provider tools is fixed** by what the
  upstreams expose.
- Need to know which Project / Organization your token is bound to ? It's
  encoded in your access_token's context — the gateway returns it implicitly
  via the bindings it auto-fills. The operator UI shows it explicitly.
