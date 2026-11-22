# Vaubaan Agent Bootstrap

> Self-contained reference for an agent (or any MCP client) that was handed
> the **key of a mission** and must work through a Vaubaan Gateway instance.
>
> This page is generic. The human who created your mission also received a
> **setup kit** with the exact values for _your_ mission (instance URL,
> accounts, resource refs, permissions, limits). When the kit and this page
> differ, the kit wins.
>
> **Two sets of words.** The interface people use says _account_,
> _permission_, _limit_, _key_, _teammate_. The protocol you speak keeps its
> names, and so do the fields, codes, tool names and variables on this page:
> `accounts` (accounts), `risk_id` / `RiskId` (a permission, by its id),
> `quota` and `rate_limit` (limits), `gate` (`auto`: runs freely; `approval`:
> asks first), `token` (a key), `member` (a teammate), `named` (a machine
> key). When you talk to a human, use the first set; when you read or write
> JSON, the second.

---

## 1. What you have

A **mission key** (`vbn_live_<prefix>_<secret>`), normally in the
environment variable `VAUBAAN_MISSION_TOKEN`. It identifies exactly one
**mission** — a named objective a human created — and exactly one **holder**:
the person who generated the key for themselves (a _teammate_ on the mission;
`member` in the protocol), or a machine the mission creator named (a _machine
key_; `named` in the protocol). Every call you make is recorded under that
holder's name. A mission carries:

- **accounts** — the company's accounts at the cloud services you may reach
  (GitHub, Supabase, Vercel…), connected by the company, never by you;
- **resources** — within each account, the repositories, projects or
  databases you may touch, by ref. Anything else is refused;
- **permissions** — a closed list, each named by its id (a `RiskId`:
  `github.read-code`, `supabase[staging].bulk-row-write`). A call that
  needs a permission outside the list is refused;
- **limits** per permission — how many actions per period (`quota`) and how
  many per short window (`rate_limit`) — and whether it **runs freely**
  (`gate: auto`) or **asks the mission creator first**, each time
  (`gate: approval`);
- an optional **period** after which the limits reset, and an optional
  expiry.

You hold **no credential of those services** and must not look for one. The
gateway mints a short-lived upstream credential for each call and never shows
it to you.

Treat the key like a password: never print it, never commit it, never send
it anywhere but the instance's MCP endpoint.

## 2. Endpoint and auth

|              |                                                |
| ------------ | ---------------------------------------------- |
| Endpoint     | `<instance URL>/mcp` (from the setup kit)      |
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

`tools/list` returns the tools of every service on which your mission holds
an account and at least one permission. The list is per service, not per
tool: a listed tool can still be refused at call time on its arguments (a
resource outside the mission, a permission the mission does not hold, a limit
reached).

Tool names are prefixed by service (`github__…`, `supabase__…`). Cite
resources by the refs of your setup kit (`owner/repo`, a project ref): they
are the only refs the mission knows.

When the mission holds several accounts of one service (two GitHub
repositories, each with its own key), the service is listed once, and its
tools take one more optional argument, `vaubaan_account`, listing the
accounts. A call that names a resource needs nothing more: the resource says
the account. A call that names none (a list, a search, a creation) names the
account with `vaubaan_account`, its name or its id; without it, the call is
refused `account-ambiguous`. With one account, never needed.

## 4. One set of limits, however many agents or keys

Sub-agents use the **same** MCP configuration and the **same** key. Every
allowed call counts against the same limits: multiplying agents does not
multiply them. A refused call counts for nothing.

**Other holders.** Several people, and machines the creator named, may work on
one mission, each with their own key. They share the mission's resources, its
permissions and its **one** set of limits: what another holder uses is used
for you too. What an agent asks — more room after a limit, a yes before an
action — is answered by the mission creator alone, whoever holds the key that
asked.

**Handing the mission to sub-agents.** An orchestrator gives each sub-agent
the MCP configuration of §2 as is: same endpoint, same
`VAUBAAN_MISSION_TOKEN`. A key belongs to its holder, not to an agent: there
is no key per agent and nothing to request for a new one.

**Agent labels.** So that the activity of the mission tells who did what,
each agent names itself:

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
what is allowed or counted, it reserves no share of the limits, and it is not
an identity — never put a secret in it. The identity of a call is the holder
of its key, which nothing you send can change.

`GET <instance URL>/mcp/catalog`, with the same `Authorization` header,
returns whose key you are using (`token.holder`: an email, or the name of a
machine key) and who created the mission (`mission.creator`), the tools of the
instance and which ones your mission can call, the resource refs and
environment labels you may cite, and what is left of each permission's limit
in the current period.

## 5. When a call is refused

A refusal is a JSON-RPC error (code `-32603`) whose `data` is the refusal:
its `code`, the fields of that code and a `hint`. Read the hint, then act
according to the code:

| Code                      | What happened                                                                                                                            | What you do                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `risk-not-accepted`       | The mission does not hold a permission this call needs.                                                                                  | Do not look for another way to the same effect. Tell the human which permissions are missing (`missing_risks`).                                                        |
| `budget-exhausted`        | The limit of a permission is reached for the period.                                                                                     | Stop that kind of action. Hand `claim_url` to the human; continue with work that does not need it. Do not retry in a loop.                                             |
| `approval-required`       | The mission creator asked to be asked first for one or more permissions of the call. `risk_ids` lists them; one request covers the call. | Nothing was executed. Hand `approval_url` to the human, wait for their yes, then replay the call with **exactly** the same arguments.                                  |
| `resource-not-in-mission` | The arguments cite a resource outside the mission.                                                                                       | Use one of the refs in `allowed_resources`, or ask the human to have the resource added.                                                                               |
| `account-ambiguous`       | The mission holds several accounts of the call's service, and the call names no resource or resources of two of them.                    | `accounts` lists each one with its resources. Call again naming one resource of the account you mean, or add `vaubaan_account` (its name or id); one call per account. |
| `rate-limited`            | Too many actions on a permission in a short window.                                                                                      | Wait `retry_after_seconds`, retry once. Nothing was counted against the limit.                                                                                         |
| `account-unavailable`     | The account behind the call needs reconnecting.                                                                                          | Nothing you can do fixes it. Tell the human who owns the account (`owner`).                                                                                            |
| `account-revoked`         | The account behind the call no longer serves this mission: removed (`final: true`) or its creator lost access (`final: false`).          | Keep using the mission's other accounts. Do not retry through that one; tell the human, who can have a mission issued for its replacement.                             |
| `mission-inactive`        | The mission is expired, without an owner (`orphaned`) or stopped (`revoked`).                                                            | Stop calling with this key and report to the human.                                                                                                                    |
| `wrong-credential-kind`   | The key was presented on the wrong door.                                                                                                 | A mission key only opens the execution endpoint (`/mcp`).                                                                                                              |

**Never work around a refusal.** No other tool, no other key, no direct
access to the service, no splitting of an action to slip under a limit.
When a refusal carries a URL (`claim_url`, `approval_url`), give that URL to
the human as is: only the mission's creator, signed in to the instance, can
answer it. They also find it under "Waiting for you".

A request opened before a mission lost its owner can be answered only until
it expires. After that, your next refused call opens a new one: hand the new
URL to the human.

**When the key itself stops working.** An HTTP 401 whose `error.data.reason`
is set means this key authenticated before and no longer does. It is not a
refusal and says nothing about the mission, which may be running for its other
holders:

| Reason               | What happened                                    | What you do                                          |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `token-rotated`      | The holder replaced this key.                    | Ask the human who gave you this key for the new one. |
| `token-revoked`      | The holder, or the mission creator, revoked it.  | Stop, and tell the human.                            |
| `holder-removed`     | The holder was removed from the mission.         | Stop, and tell the human.                            |
| `holder-deactivated` | The holder is no longer active on this instance. | Stop, and tell the human.                            |

Never look for another key to continue.

## 6. Proposing a mission

You cannot enlarge your own mission. You can _propose_ one: a JSON draft the
human pastes into **Missions → New mission → Paste an agent’s proposal**.
The instance checks it against what the human may allow, loads what passes
into the form and lists what does not; nothing exists until the human reads
the list of permissions and confirms **Create mission**.

```json
{
  "name": "Ship the billing page",
  "accounts": [
    {
      "service": "github",
      "trust_levels": { "read": "careful", "propose": "trusting" },
      "resources": { "scope": "selected", "resource_refs": ["acme/app"] }
    },
    {
      "service": "supabase",
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

Rules of a draft (the field names are the protocol's):

- an account is named by `service` (when the human can use exactly one
  account of that service) or by `account_id`;
- `resources` is `{ "scope": "all" }` or a selection by `resource_refs`;
- `trust_levels` ticks the service's macro-actions (its `get_catalog` names
  them), each at a trust level: `careful`, `trusting` or `autonomous`. Alone,
  they write the permissions, with their limits and whether each asks first;
  `policy` instead holds exactly the permissions it lists, each with its
  limits, and the trust levels beside it only redraw the form;
- `everything_i_hold: true`, only when the human asks for all they may allow
  on an account, writes every one of those permissions out;
- every permission needs a `quota` and a `rate_limit`: there is no unlimited
  permission, and no wildcard — a permission is always named by its explicit
  id (`risk_id`);
- a permission held per environment (`supabase[staging].…`) needs a selected
  resource carrying that environment label;
- ask for the least that does the job. A narrow proposal is accepted faster.

## 7. Preparing missions: the Vaubaan account

An agent can prepare missions **on behalf of a person** instead of only
proposing them (§6). It does it like any other work: with the key of a
mission on the person's **Vaubaan account**, the gateway's own service. The
person connects that account in one click (Accounts → Connect a service →
Vaubaan), creates the **platform management mission** its page offers, and
gives you its key. Same endpoint, same header, same refusals as §2 and §5:
there is no second server.

The mission's tools, always within what the person may allow, and within what
that mission accepts:

| Tool                            | What it does                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `vaubaan__list_my_accounts`     | the accounts the person owns or was given access to: permission ids, resources, macro-actions |
| `vaubaan__get_catalog`          | one service's permissions as explicit ids, its macro-actions and its trust levels             |
| `vaubaan__list_my_missions`     | the person's missions: state, permissions, what is left of each limit, who prepared each      |
| `vaubaan__preview_policy`       | checks a draft (the format of §6) and lists what the person may not allow                     |
| `vaubaan__issue_mission`        | creates the mission; returns its key once, and the setup kit                                  |
| `vaubaan__rotate_mission_token` | replaces the key of a mission this mission issued; the previous key stops working at once     |
| `vaubaan__revoke_mission`       | stops a mission for good                                                                      |

How to compose a draft that passes the first time:

1. `vaubaan__list_my_accounts`, then `vaubaan__get_catalog` for each
   service the task needs.
2. Tick, per account, **the macro-actions the task needs**, each at the
   lowest trust level that lets it run; add or trim single permissions with
   `policy`, naming each by its explicit id: there is no wildcard.
3. Give every permission in `policy` a `quota` and a `rate_limit` (the trust
   levels supply them for what they write).
4. Take an id held per environment (`supabase[prod].…`) only when a selected
   resource carries that label.
5. `vaubaan__preview_policy` until it answers `ok: true`, then
   `vaubaan__issue_mission` with the same draft.

What these tools change and what they do not:

- the **person is the creator** of every mission created there. It appears
  under their name, marked as prepared by your mission, in their Missions and
  in Activity;
- at Careful, the default of the platform management mission, issuing,
  replacing a key and stopping a mission ask the person first
  (`approval-required`, §5): hand them the URL and wait;
- a draft that exceeds what the person may allow is refused whole, with the
  list of what is not covered. More cannot be obtained here;
- a mission you create **never holds a Vaubaan account**
  (`vaubaan-account-not-allowed`), and your own mission is never rotated nor
  stopped through its own key (`self-not-allowed`);
- these tools can **never** answer a request (more room after a limit, a yes
  before an action), let a permission run freely, raise a limit, reset a
  count, connect an account, give access to one or disconnect it, or call a
  tool of another service. These stay with the human, in the web interface;
- so holding a Vaubaan account is not a way around a refusal of §5: hand the
  URL to the human. Creating yourself a wider mission to get past a refusal is
  visible to the person and will cost you their trust.

## 8. Git

When your mission holds repositories of a service this gateway serves as a
git remote (GitHub), the gateway is your remote:
`<instance>/git/<service>/<owner>/<repo>.git`, `<service>` the service's id
(`github`).
The catalog (`GET <instance>/mcp/catalog`) gives it per repository as
`git_remote`, and your setup kit has the configuration. Plain git, nothing
else to install:

```sh
git config --global credential.<instance origin>.helper \
  '!f() { echo username=mission; echo "password=$VAUBAAN_MISSION_TOKEN"; }; f'
git config --global url.<instance>/git/<service>/.insteadOf <the service's own git URL prefix>
git clone <instance>/git/<service>/<owner>/<repo>.git
```

The mission key is the password, read from the variable each time git asks.
Never put it in a URL, in `.git/config` or in a credential store.

- **Clone and fetch** need the read permission of the repository. Protocol
  versions 0, 1 and 2 work.
- **A push is decided ref by ref, every ref of it**: which branches and tags,
  deletions, rewrites (force-push), changes to CI workflow files, against the
  mission's permissions and limits. One push is one action: if one ref is
  refused, every ref of the push is.
- **A refusal** shows as `! [remote rejected] <ref> (<reason>)`, with
  `remote: Vaubaan:` lines that say what to do. When they carry a URL (an
  approval, a limit to raise), hand it to the human, wait for the answer, then
  push **exactly the same commits** again. A changed commit asks again.
- **Stale info or non-fast-forward**: the branch moved since your last fetch.
  Fetch, rebase or merge, push again. The gateway checks the value you claim
  for each ref against the service; it never takes your word for it.
- **Not supported**, and refused with a sentence: `git push --atomic`, push
  options (`-o`), signed pushes, more than 50 refs in one push, pushes too
  large for the service's comparison to review (split them), a pack larger
  than the instance's limit, Git LFS.
