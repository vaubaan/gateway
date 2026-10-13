---
title: Vaubaan Gateway (v5) — on-prem MCP gateway with budgeted missions
status: draft
---

# Vaubaan Gateway — spec

> **Status:** draft v5, complete rewrite. Replaces the v4 spec
> (multi-tenant SaaS), archived as [vaubaan-gateway.legacy.md](./legacy/vaubaan-gateway.legacy.md).
> Founding decision: ADR [pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md).
> The risk model (plugins, catalogs, slices, scope caps) is not rewritten
> here: it lives in [gateway-risk-model](./gateway-risk-model.md) and
> remains the source of truth for _which_ risk a call touches. This spec
> describes _who_ may accept _which_ risk, _how many times_, _how fast_,
> _under whose eyes_, and on which instance.
>
> From v5 on, everything in the repository is written in English (ADR
> pivot, amendment of 2026-10-12). The v4 documents, in French, are
> historical and are replaced, not translated.

## 0. Vocabulary

Twenty-eight terms, distinct and not interchangeable.

**Deployment**

- **Instance** — one deployment of the gateway, owned and operated by a
  single company on its own network. An instance is a single trust
  domain: there is no tenant, no org, no project. Everything the
  instance holds belongs to the company that runs it.
- **Operator** — the person or team that installs, configures and
  maintains the instance (identity provider, provider apps, master key,
  telemetry). The operator is not an identity of the domain; they have
  access to the configuration, not to other people's missions. Until the
  IdP is configured, the operator is whoever holds the bootstrap token.
  Afterwards, the operator is any user matching the **admin rule** of the
  instance configuration: an IdP group name or a list of emails.
- **Identity provider (IdP)** — the company's authentication service, to
  which the instance delegates the identification of humans through
  OpenID Connect. The instance stores no password.

**Identities**

- **User** — a human authenticated by the IdP. Stably identified by the
  subject the IdP provides, displayed by their email.
- **Group** — a named set of users. Comes from the IdP claims when it
  provides them, otherwise from a local table kept by the operator. A
  group can be the **owner of a connection** and the **target of a
  share**. It is never the creator of a mission: a mission always has an
  identified human behind it.
- **Principal** — a user or a group, when a rule applies to both alike
  (owner of a connection, target of a share).
- **Delegation** — a user authorizes an agent to act **on their behalf**
  on the management surface, through an OAuth consent given once in the
  interface. The agent receives a **delegated token**, short-lived,
  revocable, bounded by the user's authority and by mission management.
  A delegation has an **absolute lifetime** (ninety days unless the
  operator sets another): past it the agent must obtain the user's
  consent again, however recently it renewed its token.
  A delegated token is neither a mission token nor a human session: it
  can neither execute a provider tool nor answer a request.

**Connections and authority**

- **Provider** — a cloud service supported by a plugin (GitHub, Vercel,
  Supabase, Railway, Stripe, Cloudflare…). Static, described by its risk
  catalog.
- **Connection** — a provider authenticated into the instance by a user,
  through the provider's own authorization flow. The connection holds
  the long-lived credentials, encrypted at rest. It has an **owner**: a
  principal, user or group. By default the user who created it; they may
  transfer ownership to a group they belong to, for instance "GitHub
  admins" for the GitHub connection. Every member of an owner group
  **is** an owner: they hold full authority over the connection, that is
  every risk of the provider's catalog, and may share, reconnect,
  transfer or revoke.
- **Resource** — one thing reachable through a connection: a repository,
  a database project, a hosting project, a deployment project. Discovered
  by the plugin at connection time and refreshed on demand, kept current
  by the owner, who may label each resource with an **environment**
  (`prod`, `staging`…). The resource ref is what the agent cites in its
  arguments and what the gateway checks. Environment-qualified `RiskId`s
  (`supabase[prod].bulk-row-write`) resolve against the environment label
  of the resource a call touches; for providers where the environment
  lives in the arguments (the target environment of a deployment), the plugin derives it. A call
  that touches an environment-scoped risk on a resource carrying no
  label, or a label outside the environments the risk accepts, is
  refused: an unlabelled resource is never treated as a safe default.
- **Share** — the act by which the owner of a connection grants a target
  (user or group) a **restriction** on that connection. A share is the
  triple `(connection, target, restriction)`.
- **Restriction** — an explicit enumeration of `RiskId` from the
  provider's catalog. It is the upper bound of what the target may
  accept in their missions. Never a wildcard, never a sentinel: an empty
  restriction authorizes nothing.
- **RiskId** — identifier of an entry in a provider's risk catalog
  (`github.merge-protected`, `supabase[prod].bulk-row-write`). Defined
  in [gateway-risk-model](./gateway-risk-model.md) §4.

**Missions**

- **Mission** — a named objective for which a user issues a token. A
  mission carries one or more connections and, within each, the
  **resources it may touch** (all of the connection's resources by
  default), a closed set of accepted risks, a budget, an optional
  recurrence and an optional expiry. The
  creator of the mission is the only one who can enlarge it.
- **Mission member** — a user to whom the creator gave access to the
  mission, so that they can work on it under their own name. A member
  uses the mission as it is: same resources, same policy, same budget.
  They can read it and manage their own token; they cannot change the
  mission, answer its requests, nor add members. The creator is a member
  by construction.
- **Mission token** — the Bearer an executor (agent, script, human)
  presents to the gateway. A mission has **one or more** tokens; each
  identifies exactly one mission **and one holder**, so that every call
  is attributed. Two kinds:
  - a **member token**, generated by a member for themselves after
    signing in: the creator never sees its secret, and it stops working
    when the member is removed from the mission or deactivated;
  - a **named token**, created by the creator for something that has no
    account (a CI runner, a shared machine), identified by the name the
    creator gives it.

  All tokens of a mission draw from the **same** budget. An orchestrator
  and its sub-agents present the same token; a call may also carry an
  optional, free-form **agent label**, copied into the audit to tell
  sub-agents apart. The label is declared by the caller and has no
  effect on authorization; the token holder is authenticated.

- **Mission policy** — the table `RiskId → (budget, gate)` carried by
  the mission. The keys say **which actions** are authorized, the budget
  says **in what quantity**, the gate says **whether a human must
  validate each action**. Two missions may have exactly the same keys
  and unrelated values: an exploration mission and a bulk migration
  mission accept the same risks, not in the same proportions nor under
  the same supervision.
- **Budget** — the first value of a policy entry: a **quota** (number of
  actions allowed per period) and a **rate limit** (number of actions
  allowed per short sliding window). An accepted risk without an
  explicit budget receives the default budget of the preset it came
  from.
- **Preset** — a named policy fragment **shipped by a plugin** in its
  catalog: a list of `RiskId`s of that provider, each with a default
  budget and a default gate, plus a label and a one-line description
  (`github: read-only`, `github: developer`, `github: release manager`;
  `supabase: read-only analyst`, `supabase: staging developer`…). A
  preset is UI sugar: it pre-fills the policy of a mission for one
  connection, the creator adjusts, and the persisted policy is always the
  explicit enumeration. A preset never grants anything by itself and is
  bounded by the creator's authority at issuance.
- **Gate** — the second value of a policy entry: `auto` (the action
  passes within the budget with no intervention) or `approval` (each
  action is authorized but must be **approved by the mission creator**
  before it runs). Default `auto`.
- **Period** — for a recurring mission, the interval after which quotas
  start again from zero. A one-off mission has a single, non-renewed
  period.
- **Session** — the living history of a mission, created on the first
  call received with its token. The session records every **event** and
  allows the remaining budget to be computed instantly. A mission has at
  most one session; it spans periods.
- **Event** — a session entry: an allowed call, a refused call, or an
  administrative act on the mission (request, extension, reset,
  approval, revocation). Call events are also audit entries.
- **Request** — a message from the executor to the mission creator,
  dropped by the gateway into the **creator's inbox** and referenced by
  a URL carried in the refusal. Only the creator, authenticated by the
  IdP, can answer it. Two kinds:
  - **Claim** — when the budget is exhausted: reset or extension.
  - **Approval request** — when the action touches a risk whose gate is
    `approval`: grant or refusal for that precise action. One request
    covers the call, however many gated risks it touches.
- **Approval** — the positive answer to an approval request. Bound to
  the mission, the tool, and the exact fingerprint of the call's
  arguments, and covering every gated risk that call touches. Single-use,
  valid for a short time. The identical replayed call passes; any other
  call asks again.

**Cross-cutting**

- **Gateway** — the instance's MCP endpoint. Receives the executors'
  JSON-RPC calls, classifies, decides, mints an ephemeral upstream
  credential, forwards, audits.
- **Audit** — one immutable entry per MCP call, allowed or refused, and
  per administrative act. See §8.
- **Plugin report** — an anonymous, opt-in report of a plugin tool's
  success or failure, sent to the community collector. See §9.

## 1. Vision

Vaubaan Gateway is a server a company installs on its own premises so
that its coding agents reach its cloud services without ever holding a
credential, within the bounds of a declared objective.

1. **Credentials stay inside the company.** The instance runs on the
   company's network, behind its identity provider. No third party holds
   its cloud tokens: not Vaubaan, not a SaaS.
2. **A token is issued for an objective, not for a person.** A mission
   policy has inseparable dimensions: _which_ actions, and _in what
   quantity_. It says what the agent may risk, how many times and how
   fast. A looping agent stops on its own budget, not on a human's
   alarm.
3. **Authority narrows with every hand that passes it on.** The owner of
   a connection, user or group, has everything. They share less. The
   beneficiary issues missions that are narrower still. Every stage is
   an explicit enumeration; nothing is inherited by default. The chain
   stops at the mission: there is no machine-to-machine delegation.
4. **The executor cannot enlarge itself.** Exhausted budget, risk not
   accepted or action to approve: the refusal is structured, explains
   what to do, and points to the mission creator. The agent has no path
   to extend what it was given, nor to approve itself.
5. **An agent may prepare missions; a human remains the creator.**
   Composing a policy by hand, risk by risk, budget by budget, is
   tedious. A trusted agent, acting for a user through OAuth delegation,
   may read the user's authority, propose a policy from the task, and
   issue the mission over MCP. The mission carries the user as creator;
   they, and only they, answer requests.
6. **Trust in plugins comes from usage.** Plugins are written against the
   providers' public documentation, unit-tested on their classification,
   and validated by the anonymous reports of consenting instances.

**Positioning.** Open source, on-prem, risk-budgeted MCP gateway for
coding agents. v4 was a SaaS; v5 is a product you install.

### 1.1 Explicitly out of scope

- **No multi-tenancy.** One instance serves one company. Two companies,
  two instances. There is no org, no project, no isolation between
  tenants inside an instance.
- **No local human authentication.** No password, no magic link, no
  proprietary SSO. The instance delegates everything to the company's
  IdP through OpenID Connect. The only local secret is the operator's
  bootstrap token, used to configure the IdP and then useless.
- **No high availability.** An instance is a single process with an
  embedded store. Cache, rate limit and budget counters are local to the
  process. Replication and failover are out of scope.
- **No data migration from v4.** Cutover is manual (pivot ADR, D7).
- **No CLI or SDK proxy.** Only MCP is intercepted, as in v4
  ([mcp-only-mvp-scope](../decisions/mcp-only-mvp-scope.md)).
- **No general-purpose secret management.** The instance holds only the
  connections' credentials, only to route MCP calls.
- **No cloud resource provisioning.** The instance creates no repo, no
  project, no database at any provider.
- **No call held waiting.** The gateway always answers right away, allow
  or refusal. When a human must step in, claim or approval, it happens
  outside the call: structured refusal, creator's decision in their
  inbox, replay by the agent. No `pending` state, no polling, no
  mandatory third-party notification. This is what separates the v5
  `approval` gate from the v4 mint-time `confirm` removed by
  [unified-gates-drop-confirm](../decisions/unified-gates-drop-confirm.md).
- **No integration tests against real providers** in the project's
  automated suite. See §10.
- **No telemetry by default.** The plugin report is opt-in, per
  instance, disabled at installation.

## 2. Domain

### 2.1 Hierarchy

```
Instance                          (one company, one trust domain)
├── Configuration                 (IdP, provider apps, master key, telemetry, public URL)
├── Users[]                       (identified by the IdP)
│     └── Delegations[]           (agent authorized to manage the user's missions; delegated token)
├── Groups[]                      (IdP claims or local table)
├── Connections[]                 (owner: User | Group; 1 provider; encrypted credentials)
│     ├── Resources[]             (ref; env label; discovered at connect, labelled by the owner)
│     └── Shares[]                (target: User | Group; restriction: RiskId[])
├── Missions[]                    (creator: User; resources[] per connection; accepted_risks[];
│     │                            (budget, gate) per RiskId; period; expires_at?)
│     ├── Members[]               (users given access by the creator)
│     ├── Mission tokens[]        (one per member who generated theirs, plus named tokens;
│     │                            each rotated or revoked on its own)
│     └── Session?                (created on first call; events[]; counters per RiskId)
│           └── Requests[]        (claims and approval requests, dropped by the gateway,
│                                  decided by the creator)
└── Audit                         (cross-cutting, append-only)
```

### 2.2 Definitions

| Entity             | Short definition                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instance**       | One deployment, one company. No internal tenant.                                                                                                                                                  |
| **User**           | Human authenticated by the IdP. May own connections, belong to owner groups, receive shares, create missions.                                                                                     |
| **Delegation**     | Authorization given by a user to an agent to act on their behalf on the management surface. Produces short-lived delegated tokens. Revocable by the user. Never executes, never answers requests. |
| **Group**          | Owner of connections or target of shares. Never a mission creator. Membership resolved at each login from the IdP, or kept locally.                                                               |
| **Connection**     | Provider authenticated by a user through the provider's flow. Holds the credentials. 1 owner, user or group. Several connections possible for one provider (two GitHub accounts).                 |
| **Resource**       | A thing reachable through a connection, with a ref and an optional environment label. Discovered by the plugin, labelled by the owner.                                                            |
| **Share**          | `(connection, target, restriction)`. Gives the target the right to accept, in their missions, a subset of the restriction. Revocable by the owner.                                                |
| **Restriction**    | Enumeration of `RiskId` from the catalog of the connection's provider. Upper bound, never a wildcard.                                                                                             |
| **Mission**        | Named objective. Carries resources (a subset per connection), `accepted_risks`, budget, period, optional expiry, creator. Leaf of the authority chain: no parent or child mission.                |
| **Mission member** | User given access to a mission by its creator. Uses it as it is; manages only their own token.                                                                                                    |
| **Mission token**  | Bearer presented to the gateway. Identifies one mission and one holder (a member, or a name given by the creator). Revealed once when generated. Rotated or revoked on its own.                   |
| **Budget**         | Per accepted `RiskId`: quota per period, rate limit per sliding window. Mandatory for every accepted risk.                                                                                        |
| **Session**        | History of the mission. Counters per `RiskId` and per period. Created on the first call, never recreated.                                                                                         |
| **Event**          | Session entry: allowed call, refused call, request, extension, reset, approval, rotation, revocation.                                                                                             |
| **Request**        | Claim (reset or extension) or approval request (one precise action), addressed to the creator. States: open, granted, refused, expired.                                                           |
| **Approval**       | Creator's grant for one action: `(mission, tool, argument fingerprint)`, covering the gated risks of that call. Single-use, short-lived.                                                          |
| **Audit**          | One entry per call and per administrative act. Append-only.                                                                                                                                       |

### 2.3 States

**Connection**: `active` → `expired` (the provider rejected the
credential and refresh failed) → `active` after reconnection by any
owner; `revoked` by an owner, terminal. An `expired` connection makes
every call of the missions that carry it fail with
`connection-unavailable`, naming the connection, until someone
reconnects it. A `revoked` connection grounds no authority any more: the
missions that carry it become `orphaned`. Revoking a connection erases
its credential on the instance and, **when the provider offers a way to
do it, also withdraws the grant at the provider**; the interface says,
provider by provider, whether the grant was withdrawn there or must be
removed by hand, and keeps saying it on the revoked connection. The
local revocation never waits for the provider's answer nor depends on
it. A connection whose owner group
becomes empty (all members removed from the IdP) becomes `unowned`:
missions keep running, but nobody can share or reconnect until the
operator reassigns an owner. This is the operator's only act on the
domain.

**Share**: `active` → `revoked`, terminal. Revoking a share does not
revoke the missions the target already issued; it turns them `orphaned`
(see below).

**Mission**:

- `active` — the token is accepted, the budget has headroom on at least
  one risk.
- `exhausted` — at least one accepted risk has its quota for the period
  at zero. The mission stays `active` for the other risks; `exhausted`
  is per risk, not global. A call touching an exhausted risk is refused
  with the claim URL.
- `expired` — `expires_at` passed. Terminal unless extended by the
  creator.
- `orphaned` — the upstream authority vanished (share revoked,
  connection revoked, creator deactivated by an operator or dropped from the
  owner group that grounded their authority). Every call is refused. The
  state is **derived from the creator's current authority, never
  stored as a verdict**: if the authority comes back (the share is made
  again, the creator is back in the owner group at the next sign-in),
  the mission serves calls again, with its session and counters intact.
  A revoked connection never comes back, so its missions stay orphaned.
  The creator, or an owner of the connection, may close it.
- `revoked` — by the creator, terminal.

**Request**: `open` → `granted` | `refused` | `expired` (unanswered
after a configured delay). A `granted` claim produces an extension or
reset event on the session. A `granted` approval request produces an
approval, consumed by the first identical call, or expired.

### 2.4 The cross-cutting invariant — "the executor never sees a provider credential"

Unchanged since v4, and stronger still now that the instance lives inside
the company:

- The executor authenticates with its mission token, never with a
  provider credential.
- The gateway mints or decrypts in memory an ephemeral upstream
  credential, uses it for the call, releases it.
- The executor receives the provider's response, never a credential
  usable outside the gateway. **One deliberate exception:** a tool whose
  very purpose is to hand the agent a short-lived, narrowly scoped
  provider token, because the work cannot go through the gateway (a
  repository-scoped installation token for `git clone` and `git push`).
  Such a tool is a risk of its own in the catalog, never accepted by
  default, gated by approval in the presets that carry it, counted
  against the budget and audited like any call; the long-lived
  credential still never leaves the instance.
- An exfiltrated mission token grants the mission's rights, within its
  budget, until revocation. Nothing more. Because each token has one
  holder, the audit says whose token it was, and revoking it leaves the
  other holders working.
- An exfiltrated delegated token allows issuing missions within the
  user's authority, until revocation or expiry. It allows neither
  executing a tool nor granting a request. Every mission issued this way
  is visible to the user and marked as delegated.

## 3. Authority — composing restrictions

### 3.1 The chain

```
Connection owner              authority = the provider's full catalog
   │ share (restriction R1)
   ▼
Beneficiary (user or group)   authority = R1
   │ issues a mission (accepted_risks A1 ⊆ R1)
   ▼
Mission                       authority = A1, budget B1
   │ presented by every agent of the mission
   ▼
Executor(s)                   same token, same budget, optional agent label
```

Rules:

- **Monotonicity.** Each stage is a strict or equal subset of the stage
  above. Any attempt to exceed it is refused at issuance, with the
  explicit list of uncovered `RiskId`.
- **Enumeration.** No stage expresses "everything". An owner who wants to
  share everything clicks "select all" in the interface, and the share
  records the list resolved at the time of the click. A risk added to
  the catalog later is not covered (pivot ADR, D3).
- **Union of shares.** A user who receives several shares on the same
  connection (directly and through a group) holds the union of the
  restrictions.
- **The owner needs no share** to issue missions on their own
  connection.
- **A multi-connection mission** composes its authority connection by
  connection: `accepted_risks` is partitioned per connection, and each
  partition is checked against the creator's authority on that
  connection.
- **Resource selection.** A mission names, per connection, the resources
  it may touch; by default, all the connection's resources known at
  issuance. A call whose arguments cite a resource outside the mission's
  selection is refused with `resource-not-in-mission`, before any risk is
  evaluated. A resource discovered on the connection later is not covered
  until the creator adds it. This is the v4 binding, carried by the
  mission instead of the project: least privilege by resource, not only
  by risk.

### 3.2 The budget

The budget is what v5 adds to the risk model. It does not change _which_
risks are acceptable; it bounds _how many times_ and _how fast_ each may
be touched. The gate adds a third dimension: _under whose eyes_. A
mission policy is complete only with its three dimensions:
`accepted_risks` alone is a list of keys without values, and the gateway
refuses to issue a mission whose accepted risk has no resolved budget.
The gate has a default value, `auto`.

- **Unit.** One action = one allowed call touching the `RiskId`. A call
  touching N risks decrements N counters. A refused call decrements
  nothing.
- **Quota.** Number of actions per period. When it reaches zero, the risk
  is `exhausted` until the next period or until a claim is granted.
- **Rate limit.** Number of actions per short sliding window. It is the
  mission-level instantiation of the stateful speed cap already
  described in [gateway-risk-model](./gateway-risk-model.md) §4bis.
  There is a single speed mechanism; the mission sets its value, bounded
  by the catalog.
- **Presets, per plugin.** Each plugin ships its presets in its catalog;
  every plugin ships at least one. At issuance, the creator picks one
  preset per connection of the mission (or starts empty, or duplicates
  an existing mission); the policy is pre-filled with the preset's risks,
  budgets and gates, intersected with the creator's authority, and the
  creator adjusts risk by risk. Presets are provider-specific by design:
  what "developer" means on GitHub (write on feature branches, no merge
  on protected ones) has no generic equivalent on Stripe. The persisted
  policy is the explicit enumeration, never a preset reference, so a
  preset changed in a later plugin version does not alter existing
  missions. Every plugin's `developer`-like preset must cover the v4
  usage "one token per code project" with generous values; the interface
  shows the width of a preset in one line (how many risks, the most
  severe one, the largest quota).
- **No infinite budget.** A quota is always a number. The absence of an
  expiry is allowed; the absence of a quota is not.
- **One budget per mission, however many agents or tokens.** An
  orchestrator and its sub-agents present the same token; members each
  present their own; every action decrements the same counters.
  Multiplying agents, members or tokens does not multiply the budget.
  If two teams need distinct budgets, that is two missions.

### 3.3 The session and the remaining budget

- The session is born on the **first call** received with the mission's
  token. Before that call, the mission exists but has no history.
- The session holds, per `RiskId` and per period, the number of actions
  consumed. The remainder is computed instantly without re-reading the
  audit.
- The period rollover is computed on read, never by a background task: a
  call arriving after the end of a period sees the new period's counters
  at zero.
- The session is the source of truth for the budget. The audit is the
  source of truth for what happened. The two must agree; a structural
  test checks it (§10).

### 3.4 Requests to the creator — the claim

Every escalation to a human goes through a single mechanism: the gateway
refuses the call, drops a **request** into the creator's inbox, and puts
the request's URL into the refusal. The executor, or the human steering
it, opens or forwards it. The creator also finds it in their inbox
without anyone forwarding anything.

For the claim, raised when a call touches a risk at zero quota:

- The request page requires IdP authentication and checks that the user
  is **the mission creator**. Any other identity is refused, including a
  beneficiary of the same share.
- The creator sees the session history, the risk concerned, the
  remainder of the other risks, and chooses: reset the period, extend
  the quota, extend the expiry, or refuse. **A claim is about one risk,
  and so is its answer**: "reset the period" puts the counter of the
  claimed risk back to zero for the current period and leaves the other
  risks as they are; "extend the quota" gives back a number of actions
  on that risk, at most what the period consumed on it. A larger quota,
  or more room on another risk, is a change of the mission.
- The claim produces an event. The token does not change; the executor
  replays its call.
- A refused or expired claim does not close the mission: the risk stays
  `exhausted` until the next period.

### 3.5 Requests to the creator — the approval

Some actions are authorized but too heavy to pass unseen: merging into a
protected branch, dropping a table, emailing customers. The creator sets
the risk's gate to `approval` at issuance, or later.

- A call touching a risk gated `approval` is **refused** with
  `approval-required` and the URL of an approval request. The gateway
  executes nothing and holds nothing.
- The request shows the creator the tool, the **arguments in clear**, the
  slices touched, the remaining budget. The arguments are kept encrypted
  for the lifetime of the request, then erased; only their fingerprint
  remains in the audit.
- The creator grants or refuses. A grant produces an **approval** bound
  to `(mission, tool, argument fingerprint)`, covering the gated risks the
  request lists, single-use, valid for a short time configured by the
  operator.
- The executor replays the call **identically**. The gateway finds the
  approval, consumes it, decrements the budget, executes. A call with
  different arguments, even by one byte, asks again.
- On a request, the creator may choose to **open the gate for the rest
  of the period**: the risk switches to `auto` until the next reload,
  then returns to `approval`. This is a session event.
- A call touching several risks of which only one is gated `approval` is
  refused as a whole; the approval covers the call, not the isolated
  risk.
- **A call touching several gated risks creates one request**, which
  lists them all. The creator answers once: granting it approves the
  call, refusing it refuses the call, and opening the gate opens the
  gate of each listed risk. The executor is never sent back and forth
  for one call.
- The gate does not replace the budget: an approved action counts
  against the risk's quota and rate limit.

Both kinds of request share the inbox, the page, the IdP
authentication, the states and the expiry delay. That delay is the
request's: an unanswered approval request expires like a claim, and its
sealed arguments are erased then; the short validity configured for
approvals starts only when the creator grants. A request on an orphaned
mission cannot be granted and expires on the same delay, so that
arguments are never held longer because a mission lost its authority. The v4 mint-time
`confirm` asked a human to validate _the issuance_; the v5 `approval`
gate asks them to validate _each action_, holding neither the call nor
the mint.

The v4 machine-to-machine escalation channel (`escalation_channel` set
on a child token by its parent) disappears along with machine-to-machine
delegation. In v5, every refusal that calls for more authority goes up to
a human: `budget-exhausted` through a claim, `approval-required` through
an approval request, `risk-not-accepted` through re-issuance of the
mission by its creator.

## 4. Format / Layout

### 4.1 Execution surface

The executor has one door: the instance's execution MCP endpoint, in
JSON-RPC, authenticated by `Authorization: Bearer <mission token>`.

- **Discovery** (`tools/list`): the tools of the providers the mission
  carries. In v5.0 the list is filtered **per provider, not per tool**: a
  listed tool may still be refused `risk-not-accepted` at call time. The
  catalog endpoint below is the precise source of what a mission can
  call. Filtering per tool needs plugins to declare the risks each tool
  can touch; it is an open question (§11.2).
- **Call** (`tools/call`): classification by the plugin, intersection
  with the catalog, check `risks_touched ⊆ accepted_risks`, budget check,
  upstream credential mint, forward, audit.
- **Structured refusals**, each with an agent-readable `hint`:
  - `risk-not-accepted`: list of missing risks, slices executed.
    Unchanged since v4.
  - `budget-exhausted`: `RiskId`, quota for the period, consumed, end of
    period, **claim URL**.
  - `approval-required`: every gated `RiskId` the call touches, argument
    fingerprint, **approval request URL** (one, for the call), validity
    delay, and the instruction to replay the call identically once
    approved.
  - `resource-not-in-mission`: the ref cited, the connection, and the
    resources the mission may touch.
  - `rate-limited`: `RiskId`, limit, delay before retry.
  - `connection-unavailable`: the connection is `expired` or `revoked`;
    connection name and owner to contact.
  - `mission-inactive`: `expired`, `orphaned` or `revoked`, with the
    reason.
  - `wrong-credential-kind`: the bearer is not a mission token (a
    delegated token or a human session presented at the execution door),
    with the door that would accept it. The same code is returned by the
    management door to a mission token (§6).
- **Catalog**: a read endpoint, authenticated by the mission token,
  returning the full tool surface, what the mission may call, the refs
  and environment labels of the resources the mission may touch, and the
  remaining budget per `RiskId`. It is the agent's only source of discovery for upstream
  refs, as in v4.
- **Streaming**: a tool call is always answered by one complete result.
  A plugin reading a long upstream response may emit its parts as they
  arrive; the gateway forwards each at once as a progress notification
  to a caller that asked for progress, then closes with the result. The
  decision and the budget decrement are complete before the first part
  leaves. A stream that breaks midway is an allowed call with an
  upstream error: the credit stays consumed and nothing is replayed.

### 4.1 bis Management surface over MCP

A second MCP door, distinct from the first, for agents acting **on behalf
of a user**: the management MCP endpoint, authenticated by OAuth. The
instance is the authorization server; it relies on the IdP to identify
the user at consent time, then issues the MCP client a short-lived,
renewable delegated token bound to the user and to a management scope.
The flow follows the standard authorization of MCP servers, metadata
discovery included, so that a client such as Claude Code connects with no
special configuration.

What the management surface exposes, always within the delegating user's
authority:

- **Read**: my connections and those shared with me, with the exact
  restriction; the risk catalog of each provider concerned, with its
  presets; my missions, their policy, their session and remaining
  budget.
- **Preview** a policy: submit a draft `RiskId → (budget, gate)` on some
  connections and get back what passes, what exceeds the authority, and
  what the mission could call. Without issuing anything.
- **Issue** a mission: name, connections, policy, period, expiry. The
  recorded creator is the **delegating user**, never the agent. The
  response contains the mission token, revealed once, and the bootstrap
  kit.
- **Rotate** the token of a mission that this delegation issued,
  **revoke** one of the user's missions.

What the management surface **never exposes**, whatever scope is
requested:

- answering a request, claim or approval;
- opening a gate, extending a budget, resetting a period;
- connecting a provider, sharing, transferring, revoking a connection;
- executing a provider tool.

These acts stay reserved to the human session (§4.2). The reason is the
vision's invariant: if the agent executing a mission may also act by
delegation for its creator, there must be no path by which it enlarges
itself. Issuing a wider mission is possible but visible, within the
user's authority, and under their name; approving itself never is.

A client's standing (approved by the operator, or a loopback-only
client admitted automatically) is checked at every use of a delegated
token, not only at consent: disabling a client stops its delegations at
the next request.

A user sees their delegations in the interface, with the client holding
each one, the date its absolute lifetime ends, and the missions it
issued, and may revoke them in one click.

### 4.2 Human surface

A web interface served by the instance itself, behind the IdP. Cardinal
pages:

- **Connections** — my connections, their state, their resources with
  environment labels (edit, refresh discovery), their shares. A "Connect
  a provider" button that starts the provider's authorization flow with
  the apps registered by the operator. A "Share" button that opens the
  checklist of catalog `RiskId` with "select all".
- **Shares received** — what others entrusted to me, and the exact
  restriction.
- **Missions** — the missions I created and those shared with me as a
  member, their state per risk, their session. On a mission: its
  members and tokens (the creator adds or removes members and creates
  named tokens; a member generates, rotates or revokes their own token).
  Creation, in this order and on one screen: name (or "duplicate mission
  X", or "paste an agent's proposal"); connections and, within each, the
  resources (all by default) and the policy, **Preset or Custom per
  connection**: a preset shows what it allows, what waits for my
  approval and what it leaves out; Custom opens every risk I hold, each
  with its budget and gate, within my authority; a three-line summary of
  what the mission can do, cannot do, and in what quantity; period,
  expiry. After issuance: the **bootstrap kit** (§4.4). The screen must
  stay usable for a mission on three connections without scrolling
  through a wall of checkboxes.
- **Mission session** — event timeline, counters per risk and per
  period, gate per risk, open requests, and calls per token holder.
- **Request inbox** — claims and approval requests awaiting me as
  creator, with the action's detail for approvals.
- **Delegations** — the agents authorized to manage my missions, what
  they issued, and their revocation.
- **Audit** — search by mission, user, connection, tool, decision,
  period. **Who reads what:** a user reads the entries of the missions
  they created, of the missions shared with them as a member, and of the
  connections they own; an operator reads every entry of the instance,
  calls included. **Nobody reads arguments there**: the audit never holds
  them, and the fingerprint that stands for them is shown only to who
  answers for the call — the creator of its mission, an owner of its
  connection — never to a member or to an operator as such.
- **Providers** — the reference of each shipped plugin, for any
  signed-in user: what it connects to, its data model, its risk catalog
  with the reason and the vector of each risk, its presets with
  everything they contain, its tools. Every risk shown elsewhere links
  to its entry here.
- **Administration** (operator) — IdP, provider apps, local groups,
  telemetry, retention, public URL.

Styling follows [style-guide](./style-guide.md).

### 4.3 Instance configuration

The operator provides, at installation, through environment variables or
a mounted file, never committing anything:

- the **master key** for encryption at rest;
- the instance's **public URL** (used for provider callbacks, request
  URLs, the bootstrap kit);
- the **IdP configuration**: issuer URL, client identifier, client
  secret, claim mapping (subject, email, groups);
- per provider in use, the **app registered by the company** at that
  provider: identifier and secret, or private key for app-install
  providers;
- the operator's **bootstrap token**, usable until the IdP is
  configured;
- the **admin rule**: an IdP group name or a list of emails that defines
  who is operator once the bootstrap token is revoked;
- the **telemetry opt-in** and the collector URL (default supplied,
  overridable, disableable).

Optional keys have defaults; among them the **absolute lifetime of a
delegation** (ninety days) and the **audit retention** (ninety days).

Anything missing makes startup fail with a message naming the variable.

### 4.4 Bootstrap kit after issuance

Inherited from v4 §12.4, adapted: after a mission is issued, the
interface shows three numbered snippets to copy, and a verification
command.

1. The environment variable carrying the mission token. The secret is
   revealed once; the revisited page shows a prefix and a "Rotate"
   button.
2. The client's MCP configuration (instance URL, authorization header by
   reference to the variable).
3. An instruction block for the agent: connections carried, resource
   refs, accepted risks, budget, and what to do on each structured
   refusal (in particular: hand the request URL to the human, never try
   to work around it).

## 5. Composition

- **[gateway-risk-model](./gateway-risk-model.md)** — provides plugins,
  catalogs, slices, scope caps, the `risk-not-accepted` code and the
  speed mechanism. v5 consumes this model without modifying it; it adds
  the cumulative quota and the notion of session. One part of that
  model is **not enforced in v5.0**: the stateless scope caps (items or
  bytes per call). The execution door has no argument-normalization
  stage yet, so shipped catalogs declare none, and a structural test
  fails if one does (ADR
  [scope-caps-not-enforced-in-v5-0](../decisions/scope-caps-not-enforced-in-v5-0.md)).
  Speed is bounded by the mission's rate limit only. Sections of that
  document that speak of project, binding or org read with the mapping:
  binding → resource of a connection; project policy → share
  restriction; project-scoped root token → mission.
- **Provider plugins** — one per provider. Two responsibilities: classify
  `(tool, arguments) → slices`, execute the tool with an ephemeral
  credential. They also declare how to obtain and refresh a credential
  from the app registered by the company, how to withdraw the grant at
  the provider when a connection is revoked (or, failing that, where a
  person removes it by hand), how to discover resources, and ship at
  least one **preset** in their catalog. Contribution process:
  [CONTRIBUTING](../../CONTRIBUTING.md) and the plugin kit,
  [plugins/README](../../plugins/README.md).
- **The company's IdP** — authenticates humans, provides subject, email
  and groups. The instance trusts it for identity, never for
  authorization: shares and missions are local.
- **Providers** — each company registers its own apps. The authorization
  flow runs between the user, the provider and the instance; no third
  party.
- **Community collector** — receives plugin reports from consenting
  instances, publishes aggregated statistics. See §9.
- **MCP clients** — Claude Code, Cursor, Continue, scripts. The gateway
  does not know the client; it knows the mission.

## 6. Security

- **One trust domain.** Everything the instance holds belongs to the
  company. The instance operator has access, in running memory, to
  decrypted credentials during a call. It is the same trust proposition
  as v4
  ([trust-model-clear-at-rest-idp-style](../decisions/trust-model-clear-at-rest-idp-style.md)),
  moved from the SaaS to the company itself, which makes it acceptable
  for production credentials.
- **Encryption at rest.** Connection credentials are encrypted with a key
  derived from the master key, unique to each connection, with the
  connection identifier as authenticated data. The master key never
  lives in the store.
- **No credential to the executor.** Invariant §2.4.
- **Transport.** The instance exposes plain HTTP on the local network and
  requires being placed behind a TLS termination held by the company.
  The configured public URL must be HTTPS; provider callbacks and
  request URLs carry it.
- **Human authentication.** Delegated to the IdP. Web sessions are short
  and bound to the instance's origin. Every mutation requires a valid
  session and an origin check.
- **Separation of the three credentials.** The gateway recognizes three
  kinds of bearers and none crosses over: the **mission token** opens
  the execution surface only; the **delegated token** opens the
  management surface only; the **human session** opens the interface
  only. Requests are granted only in a human session. An executor can
  therefore neither claim for itself, nor approve itself, nor modify its
  mission, even if it also holds a delegated token of its creator.
- **Short, traceable delegated tokens.** Short lifetime, renewal through
  a revocable refresh token, scope limited to management, an absolute
  lifetime of the delegation itself after which the user consents again
  (ninety days by default, a configuration key), and every
  mission issued by delegation carries in the audit the identity of the
  delegated client and of the delegating user.
- **Authoritative, atomic counting.** The budget decision and the
  decrement are a single operation; two concurrent calls on a quota's
  last credit produce exactly one allow and one refusal.
- **Anti-replay and anti-redirect** on provider authorization flows:
  single-use nonce, return URL limited to the instance's public URL.
- **Surface rate limits** on the MCP endpoint per mission, on connection
  flows per user, on the request page per IP.
- **Mission tokens at rest.** The instance stores a SHA-256 digest of each
  mission token and never the token. The secret part is long and drawn at
  random by the instance, so a digest cannot be searched; a slow password
  hash would protect nothing and is not used. A token issued while tokens
  were stored otherwise keeps working unchanged.
- **No secret in logs.** Mission tokens are logged by prefix. Call
  arguments are never logged in clear, only hashed.
- **Immutable audit.** No update or delete from the application. Purge by
  operator-configured retention.
- **Leak-free telemetry.** See §9: no argument, no resource ref, no
  stable instance identifier.

## 7. Workflows

### 7.1 Install an instance

The operator deploys the image, provides the configuration (§4.3), opens
the interface with the bootstrap token, fills in the IdP, signs in
through the IdP, and revokes the bootstrap token. They then register one
app per provider in use and enter its secrets.

### 7.2 Connect a provider

A user clicks "Connect", is sent to the provider, consents, comes back to
the instance. The connection is created, encrypted, under their name.
The plugin discovers its resources; the owner labels their environments.
They are its owner. They may then transfer ownership to a group they
belong to; every member of the group becomes a full owner, and so will
members who join the group later.

### 7.3 Share

The owner picks a target (user or group), ticks the risks, confirms. The
target sees the share under "Shares received" and may issue missions
within that bound.

### 7.4 Issue a mission

The creator names the mission, picks its connections and, within each,
the resources it may touch, picks one preset per connection, reads the
summary, unfolds the detail only if something needs adjusting within
their authority, sets period and expiry. The token is revealed once. The
bootstrap kit is displayed.

### 7.5 Execute

The agent calls the gateway. On the first call, the session is born.
Every allowed call decrements the counters of the risks touched and
produces an event and an audit entry.

### 7.6 Exhaust and claim

A call touches a risk at zero quota. The `budget-exhausted` refusal
carries the claim URL. The human steering the agent opens it, or forwards
it to the creator. The creator authenticates, sees the session, decides.
The agent replays.

### 7.7 Approve an action

A call touches a risk gated `approval`. The `approval-required` refusal
carries the request URL. The creator sees it in their inbox, reads the
tool and the arguments, grants. The agent replays the same call; it
passes and consumes the approval. If the agent changes the arguments, a
new request.

### 7.8 Revoke and rotate

The creator revokes a mission or rotates its token without changing the
mission. The owner revokes a share or a connection; the missions that
depend on it become `orphaned` and refuse everything, with the reason.
When a connection is revoked, the owner is told what became of the
access granted at the provider: withdrawn there too, or theirs to remove
by hand, with the place to do it.

### 7.9 Work with several agents

An orchestrator that spawns sub-agents hands them its MCP configuration
as is. They present the same mission token. Each may set its agent label
on its calls so that the session and the audit tell who did what. The
budget is shared.

### 7.9 bis Work on a mission as a team

The creator adds colleagues as members of the mission. Each signs in,
finds the mission under the missions shared with them, and generates
their own token, shown once, with the bootstrap kit. Every call is then
attributed to its holder in the session and the audit. For a machine
with no account, the creator creates a named token. Any token is revoked
on its own, by its holder or by the creator. Requests still go to the
creator, who alone answers them.

### 7.10 Have an agent prepare a mission

A user connects their agent to the management surface; the OAuth flow
sends them to the instance, they authenticate through the IdP, consent,
and the agent receives a delegated token. The agent reads the user's
authority and the catalog, composes a policy from the task described,
previews it, fixes what exceeds, issues the mission. The user sees it
appear under their name, marked as delegated. The agent, or another one,
executes the mission with the mission token received. The requests that
follow land in the user's inbox, and only they answer them.

## 8. Audit

One entry per call, allowed or refused, and per administrative act.

For a call: timestamp, mission, the token used and its holder (member
or named token), connection used and resource ref, tool,
argument hash, slices executed, risks touched, snapshot of accepted
risks, decision and refusal reason, approval consumed if any, remaining
budget per risk after the call, agent label, upstream latency, client
origin. The detailed shape of the risk-related fields is that
of [gateway-risk-model](./gateway-risk-model.md) §12.

For an administrative act: timestamp, user, act (connection, share,
revocation, issuance, extension, reset, approval, rotation, delegation
granted or revoked, configuration change), object, previous and new
state when meaningful, and, when the act comes from the management
surface, the identity of the delegated client.

An entry is read by the creator of its mission, the current members of
that mission, the owners of its connection, and the operators (§4.2
"Audit"). A member who is removed stops reading the mission's entries,
past ones included.

Retention configured by the operator, 90 days by default. No cold archive
in v5.

## 9. Community telemetry

Plugins cannot be tested against real providers in the project's
automated suite. Trust comes from usage.

- **Opt-in per instance**, disabled at installation, enabled by the
  operator, visible in the interface.
- **Content of a report**: plugin identifier, plugin version, gateway
  version, tool name, outcome (`success`, `upstream-error`,
  `classification-error`, `execution-error`), normalized error class.
  Nothing else.
- **Never**: arguments, argument hashes, resource refs, mission
  identifiers, user identifiers, stable instance identifier, network
  address. A structural test checks the report's shape (§10).
- **Public aggregation**: success rate per `(plugin, version, tool)`,
  number of reporting instances. A plugin is **deemed validated** above a
  success threshold and a minimum number of reports, both published. The
  instance's interface shows this status on each connection.
- The collector is hosted by the open source project, insert-only and
  anonymous; its shape is an infrastructure decision, not part of this
  spec.

## 10. Tests

- **Unit, mandatory**, on:
  - each plugin's classifier, against recorded provider responses or
    ones built from the public docs; a classification error is a
    security hole;
  - authority composition (§3.1): monotonicity, union of shares,
    partition per connection, resource selection and
    `resource-not-in-mission`, environment resolution against resource
    labels;
  - the budget (§3.2, §3.3): multi-risk decrement, period rollover on
    read, atomicity on the last credit, several agents concurrent on the
    same token;
  - the approval (§3.5): binding to the exact argument fingerprint,
    single use, expiry, whole refusal of a multi-risk call, gate opening
    bounded to the period, erasure of arguments after decision;
  - structured refusals: every code, every field, the `hint`;
  - credential separation (§6): a mission token on the management
    surface, a delegated token on the execution surface, either on a
    request, are refused unambiguously.
- **Integration**, on an ephemeral instance with embedded store and
  simulated IdP: connection, share, issuance, claim, approval and
  replay, revocation flows, `orphaned` states, OAuth delegation then
  issuance of a mission by an MCP client within the user's authority and
  refusal beyond it.
- **End to end, acceptance criterion for the cutover**: connect the
  providers the team actually uses, issue one mission per code project,
  run the daily workflow with a coding agent with no unexpected refusal.
  Described in [e2e-tests](../tests/e2e-tests.md). Run by hand, outside
  the automated suite.
- **Structural**:
  - a telemetry report contains none of the forbidden fields (§9);
  - session counters agree with the audit;
  - no configuration value is hard-coded;
  - every persisted restriction and `accepted_risks` is an enumerated
    list, never a wildcard, never a preset reference;
  - every plugin ships at least one preset, and every preset references
    only `RiskId`s of its own catalog;
  - a user's authority on a connection is recomputed from their current
    group membership, never from a snapshot.
- **Out of scope**: integration tests against real providers.

## 11. v1 decisions & open questions

### 11.1 Settled decisions

- One instance, one company, one trust domain.
- Human identity through OpenID Connect only.
- Restriction and `accepted_risks` always enumerated.
- Budget per `RiskId`, mandatory quota, optional expiry.
- Recurrence by quota reload at a fixed period, continuous session.
- No machine-to-machine delegation. A mission has one budget and one or
  more tokens, each with one holder: a member who generated it, or a
  name given by the creator. A member uses the mission as it is and
  manages only their own token.
- Every request, claim or approval, reserved to the mission creator,
  through the IdP, never holding a call.
- Gate per risk, `auto` by default, `approval` bound to the argument
  fingerprint, single use; one request and one approval per call,
  whatever the number of gated risks it touches.
- Two MCP doors: execution by mission token, management by OAuth
  delegated token. Three credentials that never cross. Requests are
  granted only in a human session.
- Mission rate limit = instantiation of the catalog's speed cap.
- Opt-in telemetry, report shape frozen in §9.
- No v4 migration; manual cutover.
- A connection's owner is a principal, user or group; a mission always
  has a user creator.
- Presets are shipped by plugins, one per connection at issuance, UI
  sugar only; the persisted policy is always explicit.
- Resources belong to the connection, labelled with an environment by
  the owner; a mission selects a subset per connection (all by default)
  and is refused outside it.
- After bootstrap, the operator is defined by the admin rule of the
  instance configuration.

### 11.2 Open questions

- **Local groups.** When the IdP provides no groups, the local table is
  kept by the operator. Should any user be allowed to create a group?
  v1 assumption: operator only.
- **Transfer to a group one is not a member of.** May an owner transfer
  their connection to a group they do not belong to, and thus lose their
  authority? v1 assumption: no, to avoid dispossessing oneself by
  mistake; the operator can do it through `unowned`.
- **Preset values.** Each plugin's presets, their risks, default budgets
  and gates, are fixed at implementation by the plugin author and
  reviewed like the catalog. A structural test checks that every preset
  references only `RiskId`s of its own catalog and that every plugin
  ships at least one preset. Whether the gateway should also offer a
  cross-provider "duplicate this mission" as the main shortcut is a UI
  question for the missions feature.
- **Quantities in shares.** A share's restriction is a list of `RiskId`
  without quantities. Should it also carry a budget ceiling per risk that
  the beneficiary's missions could not exceed? v1 assumption: no,
  quantities live in the mission; to reconsider if usage shows
  beneficiaries granting themselves unreasonable budgets.
- **Members and authority.** A member works under the creator's
  authority: they need no share of the mission's connections. Should a
  member be required to hold that authority themselves? v1 assumption:
  no — the creator answers for the mission, as when handing a token.
- **What a member sees.** The whole session of the mission, or only
  their own calls? v1 assumption: the whole session; arguments are never
  shown, and requests stay the creator's.
- **Transitive sharing.** May a beneficiary re-share a connection to a
  third party within their restriction? v1 assumption: no, only the
  owner shares.
- **Expiry delays of requests and approvals.** Default values and
  operator configurability. An approval must live long enough for the
  agent to replay, not long enough to linger.
- **Notifying the creator.** In v1 the request inbox in the interface is
  enough, plus the URL the executor hands over. Is an optional outbound
  channel needed (webhook, mail through the company's server)? Operator
  decision, ADR if added.
- **Gate in shares.** May a share's restriction impose `approval` on some
  risks for the beneficiary's missions, with approval by the connection
  owner rather than the creator? v1 assumption: no, the gate lives in the
  mission, like quantities.
- **Several connections of one provider in a mission.** Allowed by the
  model; the interface must make the resource ref unambiguous in the
  bootstrap kit.
- **Resources in shares.** A share's restriction is a list of `RiskId`.
  Should the owner also be able to restrict a share to some resources of
  the connection? v1 assumption: no, resource selection lives in the
  mission; the beneficiary's missions may touch any resource of the
  connection within the risks shared.
- **Agent label.** How an MCP client transmits it (header, protocol
  metadata field) and whether the orchestrator can impose it on its
  sub-agents. No effect on authorization, hence decidable at
  implementation.
- **Machine-to-machine delegation.** Removed from v5: a mission's agents
  share the token. If a need to narrow a sub-agent's authority appears,
  it will be an evolution with its own ADR.
- **Scope of the management surface.** Limited to missions in v1. Should
  it include sharing connections, so that an administration agent also
  prepares a team's shares? v1 assumption: no, sharing stays a human
  gesture.
- **Automatic policy proposal.** The surface exposes reading and preview;
  composing a policy from a natural-language task is the client's job,
  not the instance's. Plugin presets are the instance-side help; the
  management surface exposes them.
- **Authorization server.** The instance issues delegated tokens itself,
  relying on the IdP for identity. The alternative, accepting IdP tokens
  directly, is a technical decision for an ADR at implementation.
- **Per-tool discovery.** `tools/list` filters per provider (§4.1).
  Should plugins declare, per tool, the risks it can touch, so that a
  mission lists only what it can call?
- **Audit export.** Format and scope of an export for companies subject
  to retention requirements beyond local retention.

---

_Date: 2026-10-12. Author: rpelissier + Claude (drafting). Status: draft
v5 for review._
