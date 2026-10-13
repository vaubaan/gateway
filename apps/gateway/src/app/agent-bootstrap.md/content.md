# Vaubaan Agent Bootstrap

> Self-contained reference for an agent (or any MCP client) that was handed a
> **mission token** and must work through a Vaubaan Gateway instance.
>
> This page is generic. The human who issued your mission also received a
> **bootstrap kit** with the exact values for _your_ mission (instance URL,
> connections, resource refs, accepted risks, budget). When the kit and this
> page differ, the kit wins.

---

## 1. What you have

A **mission token** (`vbn_live_<prefix>_<secret>`), normally in the
environment variable `VAUBAAN_MISSION_TOKEN`. It identifies exactly one
**mission** — a named objective a human issued — and exactly one **holder**:
the person who generated the token for themselves (a _member_ of the mission),
or a machine the mission creator named (a _named_ token). Every call you make
is recorded under that holder's name. A mission carries:

- **connections** — the cloud providers you may reach (GitHub, Supabase,
  Vercel…), authenticated by the company, never by you;
- **resources** — within each connection, the repositories, projects or
  databases you may touch, by ref. Anything else is refused;
- **accepted risks** — a closed list of `RiskId`s
  (`github.read-code`, `supabase[staging].bulk-row-write`). A call that
  touches a risk outside the list is refused;
- a **budget** per accepted risk — a _quota_ (actions per period) and a
  _rate limit_ (actions per short window) — and a **gate**: `auto`, or
  `approval` when a human must approve each action;
- an optional **period** after which quotas reload, and an optional expiry.

You hold **no provider credential** and must not look for one. The gateway
mints a short-lived upstream credential for each call and never shows it to
you.

Treat the token like a password: never print it, never commit it, never send
it anywhere but the instance's MCP endpoint.

## 2. Endpoint and auth

|              |                                                |
| ------------ | ---------------------------------------------- |
| Endpoint     | `<instance URL>/mcp` (from the bootstrap kit)  |
| Protocol     | MCP over HTTP, JSON-RPC 2.0, `POST`            |
| Auth         | `Authorization: Bearer $VAUBAAN_MISSION_TOKEN` |
| Content-Type | `application/json`                             |

An MCP client is configured by reference to the variable, never with the
secret itself:

```json
{
  "mcpServers": {
    "vaubaan": {
      "type": "http",
      "url": "<instance URL>/mcp",
      "headers": { "Authorization": "Bearer ${VAUBAAN_MISSION_TOKEN}" }
    }
  }
}
```

Check that it works:

```bash
curl -sS "<instance URL>/mcp" \
  -H "Authorization: Bearer $VAUBAAN_MISSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 3. Discovery

`tools/list` returns only the tools that at least one accepted risk of your
mission makes potentially callable. A listed tool can still be refused at
call time on its arguments (a resource outside the mission, a risk the
arguments reach, an exhausted quota).

Tool names are prefixed by provider (`github__…`, `supabase__…`). Cite
resources by the refs of your bootstrap kit (`owner/repo`, a project ref):
they are the only refs the mission knows.

## 4. One budget, however many agents or tokens

Sub-agents use the **same** MCP configuration and the **same** token. Every
allowed call decrements the same counters: multiplying agents does not
multiply the budget. A refused call consumes nothing.

**Other holders.** Several people, and machines the creator named, may work on
one mission, each with their own token. They share the mission's resources,
its accepted risks and its **one** budget: what another holder spends is spent
for you too. Requests (claims, approvals) are answered by the mission creator
alone, whoever holds the token that caused them.

**Handing the mission to sub-agents.** An orchestrator gives each sub-agent
the MCP configuration of §2 as is: same endpoint, same
`VAUBAAN_MISSION_TOKEN`. A token belongs to its holder, not to an agent: there
is no token per agent and nothing to request for a new one.

**Agent labels.** So that the mission's session and the audit tell who did
what, each agent names itself:

- a sub-agent started with its own copy of the configuration adds one header
  next to `Authorization`:

  ```json
  "headers": {
    "Authorization": "Bearer ${VAUBAAN_MISSION_TOKEN}",
    "X-Vaubaan-Agent": "sub-agent-2"
  }
  ```

- an orchestrator that sends the calls itself on behalf of several agents
  sets `_meta.agent` on each `tools/call` instead:
  `"params": { "name": "…", "arguments": { … }, "_meta": { "agent": "planner" } }`.
  On a call that carries both, `_meta.agent` wins.

A label is 1 to 64 characters: letters, digits and `.` `_` `-` `:` `/` `@`
`+`, starting with a letter or a digit. Anything else is ignored: the call is
served, unlabelled. A label is attribution only: it changes nothing about
what is allowed or counted, it reserves no share of the budget, and it is not
an identity — never put a secret in it. The identity of a call is the holder
of its token, which nothing you send can change.

`GET <instance URL>/mcp/catalog`, with the same `Authorization` header,
returns whose token you are using (`token.holder`: an email, or the name of a
named token) and who created the mission (`mission.creator`), the tools of the
instance and which ones your mission can call, the resource refs and
environment labels you may cite, and what is left of each risk's quota in the
current period.

## 5. When a call is refused

A refusal is a JSON-RPC error (code `-32603`) whose `data` is the refusal:
its `code`, the fields of that code and a `hint`. Read the hint, then act
according to the code:

| Code                      | What happened                                      | What you do                                                                                                                |
| ------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `risk-not-accepted`       | The call touches risks the mission did not accept. | Do not look for another way to the same effect. Tell the human which risks are missing (`missing_risks`).                  |
| `budget-exhausted`        | The quota of a risk is spent for the period.       | Stop that kind of action. Hand `claim_url` to the human; continue with work that does not need it. Do not retry in a loop. |
| `approval-required`       | The risk is gated: a human approves each action.   | Nothing was executed. Hand `approval_url` to the human, wait, then replay the call with **exactly** the same arguments.    |
| `resource-not-in-mission` | The arguments cite a resource outside the mission. | Use one of the refs in `allowed_resources`, or ask the human to have the resource added.                                   |
| `rate-limited`            | Too many actions on a risk in a short window.      | Wait `retry_after_seconds`, retry once. The quota was not consumed.                                                        |
| `connection-unavailable`  | The provider connection is expired or revoked.     | Nothing you can do fixes it. Tell the human who owns the connection (`owner`).                                             |
| `mission-inactive`        | The mission is expired, orphaned or revoked.       | Stop calling with this token and report to the human.                                                                      |
| `wrong-credential-kind`   | The token was presented on the wrong door.         | A mission token only opens the execution endpoint (`/mcp`).                                                                |

**Never work around a refusal.** No other tool, no other token, no direct
access to the provider, no splitting of an action to slip under a limit.
When a refusal carries a URL (`claim_url`, `approval_url`), give that URL to
the human as is: only the mission's creator, signed in to the instance, can
answer it.

A request opened before a mission was orphaned can be granted only until it
expires. After that, your next refused call opens a new one: hand the new URL
to the human.

**When the token itself stops working.** An HTTP 401 whose `error.data.reason`
is set means this token authenticated before and no longer does. It is not a
refusal and says nothing about the mission, which may be running for its other
holders:

| Reason               | What happened                                    | What you do                                            |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `token-rotated`      | The holder generated a newer token.              | Ask the human who gave you this token for the new one. |
| `token-revoked`      | The holder, or the mission creator, revoked it.  | Stop, and tell the human.                              |
| `holder-removed`     | The holder is no longer a member of the mission. | Stop, and tell the human.                              |
| `holder-deactivated` | The holder was deactivated on this instance.     | Stop, and tell the human.                              |

Never look for another token to continue.

## 6. Proposing a mission

You cannot enlarge your own mission. You can _propose_ one: a JSON draft the
human pastes into **Missions → New mission → Paste an agent's proposal**.
The instance checks it against the human's authority, loads what passes into
the form and lists what does not; nothing is issued until the human clicks
Issue.

```json
{
  "name": "Ship the billing page",
  "connections": [
    {
      "provider": "github",
      "preset": "developer",
      "resources": { "scope": "selected", "resource_refs": ["acme/app"] }
    },
    {
      "provider": "supabase",
      "resources": { "scope": "selected", "resource_refs": ["<project ref>"] },
      "policy": [
        {
          "risk_id": "supabase.read-data",
          "quota": 500,
          "rate_limit": { "max": 30, "window_seconds": 60 },
          "gate": "auto"
        }
      ]
    }
  ],
  "period": { "kind": "recurring", "length_seconds": 86400 },
  "expires_at": null
}
```

Rules of a draft:

- a connection is named by `provider` (when the human holds exactly one
  connection of that provider) or by `connection_id`;
- `resources` is `{ "scope": "all" }` or a selection by `resource_refs`;
- `preset` alone accepts the plugin's preset as is; `policy` accepts exactly
  the risks it lists, and a risk whose `quota` or `rate_limit` is omitted
  takes the preset's values for it;
- every accepted risk needs a quota and a rate limit: there is no infinite
  budget, and no wildcard — a risk is always named by its explicit id;
- an env-qualified risk (`supabase[staging].…`) needs a selected resource
  carrying that environment label;
- ask for the least that does the job. A narrow proposal is approved faster.

## 7. The management door

An instance has a **second MCP server**, `<instance URL>/mcp/manage`, for an
agent that acts **on behalf of a user** instead of executing a mission. It
is how an agent prepares a mission by itself, without the paste of §6.

- **Endpoint**: `<instance URL>/mcp/manage`.
- **Auth**: OAuth, the standard authorization of MCP servers. Your MCP client
  discovers the server, registers itself and opens the user's browser; the
  user signs in and consents.
- **Token**: a short-lived **delegated token** your client renews by itself.
  The door is opened by that token and never by a mission token, which it
  refuses (`wrong-credential-kind`).

In Claude Code: `claude mcp add --transport http vaubaan-manage <instance URL>/mcp/manage`,
then `/mcp` → `vaubaan-manage` → Authenticate.

Its tools, always within the authority of the user who consented:

| Tool                   | What it does                                                           |
| ---------------------- | ---------------------------------------------------------------------- |
| `list_my_connections`  | connections owned or shared: acceptable `RiskId`s, resources, presets  |
| `get_catalog`          | one provider's risks as explicit ids, and its presets entry by entry   |
| `list_my_missions`     | the user's missions: state, policy, what is left of each quota         |
| `preview_policy`       | checks a draft (the format of §6) and lists what exceeds the authority |
| `issue_mission`        | issues the mission; returns the token once, and the bootstrap kit      |
| `rotate_mission_token` | a new token for an active mission; the previous one stops working      |
| `revoke_mission`       | ends a mission for good                                                |

How to compose a policy that passes the first time:

1. `list_my_connections`, then `get_catalog` for each provider the task
   needs.
2. Start from **one preset per connection** and trim it to the task. Name
   every risk by its explicit id; there is no wildcard.
3. Give every risk a quota and a rate limit (the preset supplies them).
4. Accept an env-qualified id (`supabase[prod].…`) only when a selected
   resource carries that label.
5. `preview_policy` until it answers `ok: true`, then `issue_mission` with
   the same draft.

What the door changes and what it does not:

- the **user is the creator** of every mission issued there. It appears
  under their name, marked as issued by your client, in their Missions and
  Delegations pages and in the audit;
- a draft that exceeds the user's authority is refused whole, with the list
  of what is not covered. That list cannot be obtained here;
- the door can **never** answer a request (claim or approval), open a gate,
  extend a budget, reset a period, connect a provider, share or revoke a
  connection, or call a provider tool. These stay with the human, in the web
  interface;
- so a delegation is not a way around a refusal of §5: hand the URL to the
  human. Issuing yourself a wider mission to get past a refusal is visible
  to the user and will cost you the delegation.
