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
> It stays "draft" on purpose: the product owner's decisions of 2026-10-13
> are in, but §11.2 still lists questions nobody has decided (notifying the
> creator, per-tool discovery, audit export) and v1 assumptions that the
> pilot is meant to test. It becomes "stable" when that list is empty.
>
> From v5 on, everything in the repository is written in English (ADR
> pivot, amendment of 2026-10-12). The v4 documents, in French, are
> historical and are replaced, not translated.

## 0. Vocabulary

Twenty-eight terms, distinct and not interchangeable.

**Words.** The terms below are the names of the domain and of the protocol:
MCP tool names, refusal codes, `RiskId`s, catalog files, API fields, database
columns and configuration keys spell them this way, and so does this spec
wherever it states a rule (§2, §3, §4.1, §4.3, §5, §6, §8 to §11). The
interface speaks to people in other words. §4.2, §4.4 and §7 describe what a
person sees and does, and use the interface's; a reader of the API, of a
refusal or of the database finds the same thing under the protocol's name:

| The interface says                               | The protocol and this spec say                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| account                                          | connection                                                                            |
| access — "Who has access", "Give access"         | share; the list of permissions an access holds is its restriction                     |
| "Shared with you"                                | shares received; missions one is a member of                                          |
| permission (its id stays visible, in mono)       | risk, `RiskId`                                                                        |
| limits, per period and per minute                | budget: quota and rate limit                                                          |
| runs freely / ask me first                       | gate `auto` / `approval`                                                              |
| key, your key                                    | mission token, member token                                                           |
| machine key                                      | named token                                                                           |
| Replace key                                      | rotate                                                                                |
| Waiting for you (a yes to give, a limit reached) | request: approval request, claim; the request inbox                                   |
| connected app                                    | delegation, held by an OAuth client                                                   |
| Activity                                         | audit; the session of a mission                                                       |
| teammate                                         | mission member                                                                        |
| team                                             | group                                                                                 |
| administrator                                    | operator                                                                              |
| service; OAuth client; Reference                 | provider; provider app (the OAuth client of a provider); the reference of each plugin |
| stopped; without an owner; needs reconnecting    | `revoked`; `orphaned`, `unowned`; `expired` (of a connection)                         |
| setup kit                                        | bootstrap kit                                                                         |
| mission, preset, resource, environment           | the same                                                                              |

The page paths follow the interface's words (`/accounts`, `/waiting`,
`/activity`, `/reference`, `/settings`); the paths that belong to a protocol do
not move (the two MCP doors, the request URL a refusal carries, the callback a
company registered at a provider).

**Deployment**

- **Instance** — one deployment of the gateway, owned and operated by a
  single company on its own network. An instance is a single trust
  domain: there is no tenant, no org, no project. Everything the
  instance holds belongs to the company that runs it.
- **Operator** — the person or team that installs, configures and
  maintains the instance (sign-in providers, the OAuth client of a
  provider that connects that way, master key, telemetry). The operator is not an identity of the domain; they have
  access to the configuration, not to other people's missions. During the
  setup, the operator is whoever holds the bootstrap token (the setup
  link). Afterwards, the operators are the **administrators** of the
  instance.
- **Administrator** — a user the instance itself names as such: in its
  store, never in its configuration after the first start. An
  administrator is named by the setup (the holder of the setup link names
  the first one), by another administrator, once by the configuration's
  **admin rule** while the instance names nobody yet (its first start, or
  the upgrade of an instance from before this rule), or by the holder of
  the master key through the recovery. An administrator is a person, an
  address waiting for its first sign-in through a provider, or a group of
  a named sign-in provider (every member that provider claims). A change of
  the configuration's rule afterwards names nobody by itself: it is shown,
  and an administrator applies it or not.
- **Identity provider (IdP), sign-in provider** — an authentication
  service to which the instance delegates the identification of humans:
  the company's directory through OpenID Connect (Entra ID, Google
  Workspace, Okta, Keycloak), or a public service where private persons
  hold their own accounts (a personal Google or Microsoft account through
  OpenID Connect, GitHub through its OAuth sign-in), or the instance's own
  **local accounts**. An instance may offer **several sign-in providers at
  once**; each has an id, a name, and its own admission rule. The instance
  stores no password but its local accounts'.
- **Local account** — an email address and a password kept by the instance
  itself, with a second factor (a one-time code from an authenticator app,
  and recovery codes shown once), for a company without a directory of its
  own. Local accounts are a sign-in provider of their own kind (`local`, at
  most one per instance), always "invited only": an account exists only for
  an invited address or an administrator, and is created by the
  person through a single-use link, or by the setup for the first
  administrator (any address the holder of the setup link types).
- **Second factor** — a one-time code from an authenticator app (with
  recovery codes shown once) that the instance itself asks at the end of
  every sign-in, through any provider, of every person: enrolled at their
  first sign-in. An administrator may waive it for a sign-in provider whose
  directory enforces its own — outright, or only when the provider says in
  the sign-in that it asked one —, never for an administrator.
- **Open provider** — a sign-in provider at which anyone in the world can
  hold an account (GitHub, Google accounts outside a Workspace, Microsoft
  personal accounts). It never admits by itself: it needs allowed email
  domains or the invitation list. A tenant provider (an Entra tenant, a
  Workspace restricted to its domain, the company's Okta or Keycloak) may
  admit everyone its directory authenticates.
- **Invitation** — an email address an administrator allowed to sign in,
  instance-wide, through any provider that verified it. The administrators
  — a person, an address, or a member of a named group — need none.

**Identities**

- **User** — a human authenticated by a sign-in provider. Stably
  identified by the pair (issuer, subject) the provider vouches for,
  displayed by their email. **Identities never merge by email**: the same
  person signing in through two providers is two users, and the instance
  offers no way to join them.
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
  through the provider's own authorization flow with the app the company
  registered there, or — for a provider whose plugin offers it — with a
  token the user created at the provider and pasted (often on one shared
  service account per provider: the instance decides who may do what, and
  the audit says who did). Both ways coexist; neither replaces the other.
  The connection holds the long-lived credentials, encrypted at rest. It has an **owner**: a
  principal, user or group. By default the user who created it; they may
  transfer ownership to a group they belong to, for instance "GitHub
  admins" for the GitHub connection. Every member of an owner group
  **is** an owner: they hold full authority over the connection, that is
  every risk of the provider's catalog, and may share, reconnect,
  transfer or revoke.
- **Resource** — one thing reachable through a connection: a repository,
  a database project, a hosting project, a deployment project. Discovered
  by the plugin at connection time, refreshed on the owner's demand and
  right after a call through the gateway that created one (the plugin
  declares which calls create a resource; the refresh never delays the
  call's answer), kept current by the owner, who may label each resource with an **environment**
  (`prod`, `staging`…). The owner may also give the connection a
  **default environment** — one of the environments of the provider's
  catalog — that every resource of the connection without a label of its
  own carries, including resources discovered later; a resource's own
  label, set by the owner or by the plugin, always wins over it. Setting
  or clearing it is an explicit, audited act of an owner. The resource ref is what the agent cites in its
  arguments and what the gateway checks. Environment-qualified `RiskId`s
  (`supabase[prod].bulk-row-write`) resolve against the environment label
  of the resource a call touches; for providers where the environment
  lives in the arguments (the target environment of a deployment), the plugin derives it. A call
  that touches an environment-scoped risk on a resource carrying no
  label — neither its own nor its connection's default —, or a label
  outside the environments the risk accepts, is refused: an unlabelled
  resource is never treated as a safe default. A default the owner chose
  for the connection is a label, not a guess, and applies as one.
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
  **resources it may touch** (all of the connection's resources known at
  issuance by default; the whole connection, resources discovered later
  included, when the creator chooses it — §3.1), a closed set of accepted risks, a budget, an optional
  recurrence and an optional expiry. The
  creator of the mission is the only one who can enlarge it.
- **Mission member** — a user to whom the creator gave access to the
  mission, so that they can work on it under their own name. A member
  uses the mission as it is: same resources, same policy, same budget.
  They can read it, manage their own token and leave it; they cannot
  change the mission, answer its requests, nor add members. The creator is
  a member by construction, and does not leave: they revoke the mission.
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
  Beside the plugin's presets, the gateway offers one **built-in preset**
  on every connection, **"Everything I hold on this account"**
  (`everything-i-hold`): it stands for every non-deprecated `RiskId` the
  creator's authority covers on that connection and the selected resources
  can reach, the fallback included, and it is **expanded into that explicit
  list at preview and at issuance**, each line with an explicit budget and
  gate (§3.2). Like any preset it never reaches the store, the token or the
  audit: the mission holds the list.
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
  a URL carried in the refusal or returned by a deliberate permission request. Only the creator, authenticated by the
  IdP, can answer it. Three kinds:
  - **Claim** — when the budget is exhausted: reset or extension.
  - **Approval request** — when the action touches a risk whose gate is
    `approval`: grant or refusal for that precise action. One request
    covers the call, however many gated risks it touches.
  - **Permission request** — deliberately raised by an agent after a missing-permission
    refusal; the creator adds the requested permissions with limits, or refuses (§3.3 bis).
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
- **No identity beyond the instance's own.** No magic-link sign-in, no
  proprietary SSO, no federation: a person signs in through the company's
  directory (OpenID Connect), GitHub, or the instance's local accounts
  (an email, a password and a second factor, kept here). An invitation is
  an entry of an allow-list, not a credential: it signs nobody in; with
  local accounts it also carries the link through which the invited person
  creates theirs. The operator's bootstrap token sets sign-in up and is then
  useless.
- **No account linking.** Two identities of one person stay two users.
- **No high availability.** An instance is a single process with an
  embedded store. Cache, rate limit and budget counters are local to the
  process. Replication and failover are out of scope.
- **No data migration from v4.** No coexistence and no migration of the
  v4 database's history. A one-shot importer carries what an organization
  needs to work — the accounts whose key can be carried as is, the resources
  with their environment labels, one mission per working v4 token with its
  permissions translated one by one, never widened — under a named owner,
  through the same checks as the interface; the other accounts are
  connected by hand (pivot ADR, D7 as amended on 2026-10-15; ADR
  [import-from-v4-one-shot-importer](../decisions/import-from-v4-one-shot-importer.md)).
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
├── Configuration                 (IdP, OAuth clients of providers, master key, telemetry, public URL)
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
│           └── Requests[]        (claims, approval and permission requests,
│                                  decided by the creator)
└── Audit                         (cross-cutting, append-only)
```

### 2.2 Definitions

| Entity             | Short definition                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instance**       | One deployment, one company. No internal tenant.                                                                                                                                                         |
| **User**           | Human authenticated by the IdP. May own connections, belong to owner groups, receive shares, create missions.                                                                                            |
| **Delegation**     | Authorization given by a user to an agent to act on their behalf on the management surface. Produces short-lived delegated tokens. Revocable by the user. Never executes, never answers requests.        |
| **Group**          | Owner of connections or target of shares. Never a mission creator. Membership resolved at each login from the IdP, or kept locally.                                                                      |
| **Connection**     | Provider authenticated by a user through the provider's flow or with a pasted token. Holds the credentials. 1 owner, user or group. Several connections possible for one provider (two GitHub accounts). |
| **Resource**       | A thing reachable through a connection, with a ref and an optional environment label. Discovered by the plugin, labelled by the owner.                                                                   |
| **Share**          | `(connection, target, restriction)`. Gives the target the right to accept, in their missions, a subset of the restriction. Revocable by the owner.                                                       |
| **Restriction**    | Enumeration of `RiskId` from the catalog of the connection's provider. Upper bound, never a wildcard.                                                                                                    |
| **Mission**        | Named objective. Carries resources (a subset per connection), `accepted_risks`, budget, period, optional expiry, creator. Leaf of the authority chain: no parent or child mission.                       |
| **Mission member** | User given access to a mission by its creator. Uses it as it is; manages only their own token.                                                                                                           |
| **Mission token**  | Bearer presented to the gateway. Identifies one mission and one holder (a member, or a name given by the creator). Revealed once when generated. Rotated or revoked on its own.                          |
| **Budget**         | Per accepted `RiskId`: quota per period, rate limit per sliding window. Mandatory for every accepted risk.                                                                                               |
| **Session**        | History of the mission. Counters per `RiskId` and per period. Created on the first call, never recreated.                                                                                                |
| **Event**          | Session entry: allowed call, refused call, request, extension, reset, approval, rotation, revocation.                                                                                                    |
| **Request**        | Claim, approval for one precise action, or explicit request for missing permissions, addressed to the creator. States: open, granted, refused, expired.                                                  |
| **Approval**       | Creator's grant for one action: `(mission, tool, argument fingerprint)`, covering the gated risks of that call. Single-use, short-lived.                                                                 |
| **Audit**          | One entry per call and per administrative act. Append-only.                                                                                                                                              |

### 2.3 States

**Connection**: `active` → `expired` (the provider rejected the
credential and refresh failed) → `active` after reconnection by any
owner; `revoked` by an owner, terminal. An `expired` connection makes
every call of the missions that carry it fail with
`connection-unavailable`, naming the connection, until someone
reconnects it. A `revoked` connection grounds no authority any more: the
missions that carry it lose their part on it, for good — every call through
it is refused `connection-revoked` —, and keep serving through their other
connections; a mission left with no connection that serves becomes
`orphaned` (amended on 2026-10-21, ADR
[orphaned-missions-and-ownerless-connections](../decisions/orphaned-missions-and-ownerless-connections.md)).
Nothing takes the lost part's place: the account that replaced it is reached
by a new mission. Revoking a connection erases
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
revoke the missions the target already issued. A mission whose creator then
holds nothing on that connection loses its part on it, as for a revoked
connection but reversibly: it comes back when an access covers it again. A
mission left with no connection that serves, or one that the share's
replacement no longer covers (a narrowed restriction), becomes `orphaned`
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
- `orphaned` — the upstream authority vanished as a whole: none of its
  connections serves it any more (each revoked, or the creator's access to
  it withdrawn: a share revoked, the creator dropped from the owner group
  that grounded it), a share was narrowed under one of them, or the creator
  was deactivated by an operator. Every call is refused. A mission that
  lost some of its connections but not all is not orphaned: it serves
  through the others, refuses `connection-revoked` through the lost ones,
  and says which (§7.8). The
  state is **derived from the creator's current authority, never
  stored as a verdict**: if the authority comes back (the share is made
  again, the creator is back in the owner group at the next sign-in),
  the mission serves calls again, with its session and counters intact.
  A share that would bring orphaned missions back names them to the owner
  before it is made (§7.3).
  A revoked connection never comes back, so a mission that has nothing
  else stays orphaned, and the part of one that has stays lost.
  An orphaned mission may be closed — revoked, for good — by its
  creator, or by an owner of one of the connections it carries. An owner
  has that right only while the mission is orphaned: a mission that
  serves is its creator's alone, and an owner who is not its creator is
  not told it exists.
- `revoked` — by the creator, terminal.

**Request**: `open` → `granted` | `refused` | `expired` (unanswered
after a configured delay). A `granted` claim produces an extension or
reset event on the session. A `granted` approval request produces an
approval, consumed by the first identical call, or expired. A granted permission
request changes the mission's permissions; it does not execute the refused call.

### 2.4 The cross-cutting invariant — "the executor never sees a provider credential"

Unchanged since v4, and stronger still now that the instance lives inside
the company:

- The executor authenticates with its mission token, never with a
  provider credential.
- The gateway mints or decrypts in memory an ephemeral upstream
  credential, uses it for the call, releases it. The same holds for a
  provider protocol the gateway relays under the mission's permissions —
  git, through the instance's git remote (§4.1 ter): the executor presents
  its mission token as the password, the gateway presents the provider's
  credential upstream, and neither crosses to the other side.
- The executor receives the provider's response, never a credential
  usable outside the gateway. **One deliberate exception:** a tool whose
  very purpose is to hand the agent a short-lived, narrowly scoped
  provider token, because the work cannot go through the gateway (a tool
  that speaks to the provider directly — Git LFS, a provider CLI). No
  shipped plugin declares such a tool since the GitHub App left (ADR
  [one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md));
  the contract keeps the place for one. Plain `git clone` and `git push`
  go through the gateway's git remote (§4.1 ter) and need no such token.
  Such a tool is a risk of its own in the catalog, never accepted by
  default, counted against the budget and audited like any call; the
  long-lived credential still never leaves the instance. **In a preset, a
  token-handing risk that grants write is gated by approval; a read-only
  one may be automatic** (a clone token reads what the mission already
  reads through the gateway; a push token writes where no risk decision
  follows it). A plugin declares which of its token-handing risks are
  read-only; one it does not declare is treated as write, and a preset
  that leaves it automatic is refused when the plugin is loaded.
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
  the catalog later is not covered (pivot ADR, D3). A creator who wants a
  mission as wide as their authority picks the built-in preset "Everything
  I hold on this account" (§3.2): the same rule applies — it is resolved to
  the explicit list at issuance, and a later change of the authority or of
  the catalog does not widen the mission.
- **Union of shares.** A user who receives several shares on the same
  connection (directly and through a group) holds the union of the
  restrictions.
- **The owner needs no share** to issue missions on their own
  connection.
- **A multi-connection mission** composes its authority connection by
  connection: `accepted_risks` is partitioned per connection, and each
  partition is checked against the creator's authority on that
  connection. A mission carries **at most one connection per provider**:
  a `RiskId` names the provider, so two connections of one provider would
  share one partition and one budget. A draft that names two is refused
  with a message that names both and says to issue a second mission.
- **Resource selection.** A mission names, per connection, the resources
  it may touch; by default, all the connection's resources known at
  issuance. A call whose arguments cite a resource outside the mission's
  selection is refused with `resource-not-in-mission`, before any risk is
  evaluated. A resource discovered on the connection later is not covered
  until the creator adds it — unless the creator chose, explicitly, **the
  whole connection**: then the mission reaches every resource of the
  connection that discovery returns at the time of the call, known at
  issuance or discovered later, except the ones the owner hid and the
  instance's own; a resource discovery no longer returns is not reached.
  A resource created through the gateway is discovered right after the
  call that created it, so such a mission reaches it from its next calls;
  one created elsewhere waits for the owner's refresh (ADR
  discovery-runs-after-a-creating-call).
  That choice is never a default and never applied to a mission issued
  with another selection; the mission page and the bootstrap kit state it
  ("the whole account, including resources found later") with the
  resources known now. Environment-qualified risks are checked at issuance
  against the resources known then; a resource discovered later reaches
  them once it carries the label (ADR
  mission-reaches-the-whole-connection-on-request). This is the v4
  binding, carried by the mission instead of the project: least privilege
  by resource, not only by risk.
- **The instance's own resources.** A resource that hosts or runs the
  instance (on Railway, the project it runs in; elsewhere, what the
  operator lists in the configuration) is never a mission resource,
  whatever a connection lists or a policy names: it is not offered at
  issuance, a draft that selects it is refused, a call that cites it is
  refused with `resource-not-in-mission`, and the account page says why.
  No plugin can change this set.

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
- **The built-in preset "Everything I hold on this account"**
  (`everything-i-hold`, ADR preset-everything-i-hold-expands-explicitly),
  offered on every connection next to the plugin's presets, wherever a
  preset is chosen (the creation form, the management surface). At preview
  and at issuance it expands into one explicit line per `RiskId` of the
  connection's catalog that the creator's authority covers **now**, that is
  not deprecated, and that the selected resources can reach — an
  environment-qualified id only when a selected resource carries that
  label (its own or the connection's default environment) or the plugin
  derives the environment from the call. The catalog's fallback is
  included, and named. Each line receives, by one documented rule: the
  catalog's rate ceiling when the entry sets one (else the largest rate a
  preset of the plugin gives it, else a value by severity level), a quota
  that is the largest any preset of the plugin gives it (else a value by
  severity level), sized for a daily period, and the gate `auto`. The
  preview states plainly how many lines it yields, the most severe, which
  lines are critical by the catalog's severity and run freely, and the
  fallback by its id; no gate is added silently. The creator confirms the
  explicit list like any other, and adjusts it like any other.
- **No infinite budget.** A quota is always a number. The absence of an
  expiry is allowed; the absence of a quota is not.
- **Changing the limits.** The creator may change, per risk already in
  the mission, its quota per period and its rate limit, up or down, at any
  time while the mission is not revoked or orphaned. Adding or removing risks
  follows the permission-edit rule below; never the period nor the rate window,
  never on behalf of the creator by a delegation. A change is bounded
  exactly as an issuance is — the creator's authority on the connection at
  that instant, the catalog's ceilings, a quota that is a number — and is
  checked by the same rule. It applies to the current period at once: what
  was consumed stays consumed, and a quota lowered under it leaves the risk
  `exhausted` until the next period. The decision of a call and its
  decrement read the limits in force when they run: no call decided after
  the change is allowed above the new limit. Every change is one
  administrative act carrying the limits before and after.
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

### 3.3 bis Editing permissions and asking for a missing permission

The creator, signed in through the human interface, may add and remove
permissions on the mission's existing accounts and resources. Additions require
explicit limits and a gate, validated as at issuance against the creator's
current authority. The change applies to every holder with the same keys,
session and history. Consumed budget is never reset, including when a removed
permission is added again. Revoked and orphaned missions cannot be edited.
The creator reviews the additions and removals before saving; concurrent edits
cannot silently overwrite each other. Changes and decisions are audited.

A missing-permission refusal opens no request automatically. The agent may
explicitly request its missing permissions, using a reference to that refusal
and explaining why the assigned task needs them. The reference is valid for
15 minutes and belongs to the authenticated mission and token. A request
contains the observed tool and missing permissions; its justification is
identified as the agent's text. Only the creator may answer: add permissions
with explicit budgets and gates, using the same validation as a direct edit,
or refuse. An answer never executes the call; the agent must retry.

Open requests with the same mission, holder and missing permissions are reused.
At most ten new permission requests per mission may be created in a rolling
24 hours. A reference already used returns its existing request, even after a
decision. Requests share the inbox, creator-only access and configured expiry
of the other requests. Neither execution nor delegated credentials may grant
them or change a live mission's permissions.

### 3.4 Requests to the creator — the claim

Claims and approval requests are automatic: the gateway refuses the call,
drops a **request** into the creator's inbox, and puts
the request's URL into the refusal. Permission requests (§3.3 bis) use the same
inbox but require the executor to ask explicitly after the refusal.
The executor, or the human steering
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
  or more room on another risk, is a change of the mission's limits by its
  creator (§3.2), never an answer to a request.
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
  slices touched, the remaining budget. One exception: an argument the
  plugin declares secret (a secret's value) is shown as a short
  fingerprint, never in clear; its key (the secret's name) stays. The
  arguments are kept encrypted for the lifetime of the request, then
  erased; only their fingerprint remains in the audit.
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

All kinds of request share the inbox, the page, the IdP
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
an approval request, `risk-not-accepted` through a permission edit of the
mission by its creator.

## 4. Format / Layout

### 4.1 Execution surface

The executor has the instance's execution MCP endpoint, in JSON-RPC,
authenticated by `Authorization: Bearer <mission token>`, and — for a
provider whose agents speak git — the git remote of §4.1 ter, the second
door of the same surface: the same token, the same admission, the same
decision and the same audit.

- **Discovery** (`tools/list`): the tools of the providers the mission
  carries, a connection it lost excepted (§2.3). In v5.0 the list is filtered **per provider, not per tool**: a
  listed tool may still be refused `risk-not-accepted` at call time. The
  catalog endpoint below is the precise source of what a mission can
  call. Filtering per tool needs plugins to declare the risks each tool
  can touch; it is an open question (§11.2).
- **Call** (`tools/call`): classification by the plugin, intersection
  with the catalog, check `risks_touched ⊆ accepted_risks`, budget check,
  upstream credential mint, forward, audit.
- **Structured refusals**, each with an agent-readable `hint`:
  - `risk-not-accepted`: list of missing risks, slices executed, and a short-lived
    refusal reference for an explicit permission request (§3.3 bis).
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
  - `connection-unavailable`: the connection is `expired` (the provider
    rejected its credential); connection name and owner to contact.
    A `revoked` connection is not answered this way.
  - `connection-revoked`: the connection no longer serves this mission,
    which still serves through its other connections (§2.3): connection
    id and name, the cause (`connection-revoked`: removed by its owner;
    `access-withdrawn`: the creator's access to it was withdrawn) and
    whether it is final. The hint tells the agent to keep using the other
    accounts and to ask the mission's creator for a mission on the account
    that replaced it. Git through the gateway on that connection is refused
    the same way.
  - `mission-inactive`: `expired`, `orphaned` or `revoked`, with the
    reason. `orphaned` covers every loss of the creator's authority as a
    whole, every connection revoked included.
  - `wrong-credential-kind`: the bearer is not a mission token (a
    delegated token or a human session presented at the execution door),
    with the door that would accept it. The same code is returned by the
    management door to a mission token (§6).
- **A token that stopped working** is not a structured refusal: the
  mission may still be serving its other holders. It is answered `401`,
  with one of four reasons, stated only to a caller whose secret was
  recognised (an unknown bearer gets the `401` and nothing else):
  - `token-rotated`: its holder generated a newer one;
  - `token-revoked`: its holder, or the creator, revoked it;
  - `holder-removed`: its member was removed from the mission;
  - `holder-deactivated`: its member was deactivated on the instance.

  Such a call consumes nothing and leaves no call entry; the rotation,
  revocation, removal or deactivation has its own administrative entry.

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
  what the mission could call. Without issuing anything. A connection of a
  draft may name a plugin preset or the built-in `everything-i-hold`
  (§3.2); the preview answers with the explicit lines it expands to.
- **Issue** a mission: name, connections, policy, period, expiry. The
  recorded creator is the **delegating user**, never the agent. The
  response contains the mission token, revealed once, and the bootstrap
  kit.
- **Rotate** the token of a mission that this delegation issued,
  **revoke** one of the user's missions.

What the management surface **never exposes**, whatever scope is
requested:

- answering a request, claim or approval;
- opening a gate, extending a budget, changing a mission's limits,
  resetting a period;
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

A user sees their delegations in the interface (§4.2, "Connected apps"),
with the client holding each one, the date its absolute lifetime ends, and
the missions it issued, and may revoke each of them; the revocation is asked
first.

### 4.1 ter Git remote — the second door of the execution surface

For a provider whose plugin declares it (GitHub in v5.0), the instance is
the agent's git remote: `https://<instance>/git/<owner>/<repo>.git`. The
agent needs git and its mission token, nothing else.

- **Authentication**: the mission token is the HTTP password (any user
  name), read by a credential helper from the variable of the setup kit
  (§4.4), never written in a URL or a file. Admission is the execution
  door's, shared and not copied: the same verifier, the same `401`
  reasons, the same `wrong-credential-kind`, the same per-mission rate
  limit, one window for both doors. A missing or rejected password is a
  `401` with a Basic challenge.
- **Fetch and clone** are relayed to the provider as a stream, never
  stored: protocol versions 0, 1 and 2. The transfer of objects is one
  call (risk `read-code` for GitHub), counted and audited like a tool
  call; listing refs is checked, not counted.
- **Push** is decided **ref by ref, every ref of it**: branches and tags
  only, never the gateway's own temporary refs; creation, fast-forward,
  rewrite (force-push), deletion, tags and changes to CI workflow files
  each map to permissions of the catalog. The whole push is **one call**:
  one decision, one request to the creator when gated, one audit entry;
  if one ref is refused, every ref of the push is. The values the client
  claims for the refs are checked against the provider: a push based on
  stale information is refused. What a push brings is what no branch at the
  provider already holds — a new branch is not measured against a default
  branch it never came from — and every commit of it is reviewed, not only
  the net change: a CI workflow changed and changed back inside one push
  still asks for the permission to change workflows. A push its
  mission, its permissions or its limits refuse is refused before its
  content leaves for the provider.
- **How it works**: the pack is streamed to the provider under temporary
  refs, never read by the gateway; the provider says what each update
  brings (commits, changed paths); then the decision; then the refs move,
  each reported on its own; a rewrite or a deletion moves only if the ref
  still holds the value that was reviewed. Temporary refs are deleted on
  every path, carry no mission identifier and are left out of the ref
  listings the gateway relays; those of a push waiting for an approval stay
  until the request expires, so the creator can read the change at the
  provider, and a scheduled sweep removes any that outlived their deadline.
  A mission holds a bounded number of them, and runs a bounded number of
  pushes at once.
- **Refusals** reach git as words git prints: the reason on the rejected
  ref, what to do on `remote:` lines, the approval or claim URL whole. An
  approved push is replayed by pushing **the same commits** again; a
  changed commit asks again (§3.5).
- **Fail closed**: a capability the gateway does not implement (atomic
  pushes, push options, signed pushes — signed commits cross unchanged),
  asked anywhere in the request, a malformed or oversized request,
  more refs than a push may carry, a pack larger than the configured cap, a
  push the provider cannot compare in full: refused with a sentence and
  audited. Git LFS is not served. A mission that may not push is not offered
  the push at all.
- The git tools are not MCP tools: calling them over MCP is a structural
  rejection, and the git door reaches no other tool.

### 4.2 Human surface

A web interface served by the instance itself, behind the IdP, in the
interface's words (§0, "Words"). One navigation of seven entries — Now,
Waiting for you, Missions, Accounts, Activity, Reference, Settings — and one
home. A page is offered an act only when the instance would take it, and the
instance checks again when the act arrives.

Above the navigation, the product and **the instance's name** (§4.3), so
that someone with several instances open knows which one they are looking
at; the host of its public URL stays one hover away. The title of every
page — what a browser tab shows — carries the name too ("<name> ·
Vaubaan"), and so does the sign-in page. Without a name, the host of the
public URL stands in its place. The name is shown as text, never
interpreted as markup.

- **Now** — the home, and the only one. It has three forms. _Something
  waits_: what my missions ask of me comes first — each request with who
  asks, on which mission, the tool and the room left — then the missions that
  are running, one line each, a limit being drawn only when it is near or
  reached; then a line of counts that lead elsewhere. _Nothing waits_: one
  sentence that says so and how many missions are running; what is running is
  one click away, and the page remembers the click. _First run_, for someone
  who created no mission: what the product is, the model in one drawing, and
  the steps — an account, a first mission, the kit; an administrator reads
  first what is left to set up on the instance; what colleagues shared with
  me is listed. **A yes is never given from the home**: an approval request
  leads to its own page; a refusal, which runs nothing, may be given from the
  row.
- **Waiting for you** — the request inbox: the requests awaiting me as
  creator, the oldest open beside the list; one sentence when nothing waits.
  Each request also has its own page, at the URL the executor hands over,
  read in this order: who asks and on which mission, the call — the tool and,
  for an approval, **the arguments in clear**, secret values as a
  fingerprint —, the permission and its
  severity, the room left, what each answer does, then the answers. **A yes
  is given on this page only**, where the exact call is shown. To an approval
  request: approve this call, let the permission run freely until the limits
  reset, or refuse. To a limit that was reached: reset the count, give back
  some calls, extend the mission, or leave it until the reset; these answers
  are about the claimed permission alone (§3.4), and a limit is changed for
  good on the mission, never from a request; the page leads there. A request that is
  no longer open shows what became of it; anyone but the creator reads one
  sentence and nothing of the request.
- **Missions** — the missions I created and those shared with me as a
  teammate: what each is for, its state in words, what it allows, when it
  ends; a mission that waits for my answer says so on its row, and a mission
  a connected app prepared names the app. **Creating**, on one screen: a name
  (or a copy of one of my missions, or an agent's proposal pasted in); the
  accounts and, within each, the resources — every resource known now (the
  default), the whole account including resources found later, or the ones
  I pick, each choice explained in one line — and a **preset**
  — each saying what it yields within what I may allow, and why when it
  would allow nothing; the last one, **"Everything I hold on this
  account"**, says how many permissions it writes out, the most severe,
  which critical ones run freely and that it includes the uncategorized
  writes — or the permissions **one by one**, each with its
  limits and whether it asks me first, one click from any preset; how often
  the limits reset and when the mission ends; beside the form, a summary of
  what the mission can do, what asks first and what it cannot do. **Creating
  confirms the explicit list**: before anything exists, a dialog lists every
  permission, by account, with its limits and whether it asks first; that
  list is what is created and what the instance checks again. Then the key,
  shown once, with the **setup kit** (§4.4). **On a mission**: its state; a
  **waiting request is visible on its mission** — with the way to answer for
  the creator, and whose answer it waits for a teammate —; what it can do,
  what asks first and what it cannot; its **people and keys**, with what each
  key did in the current period (the creator adds and removes teammates and
  makes machine keys; a teammate generates, replaces and revokes their own
  key, and may leave the mission); its permissions with what was used and
  what is left, where the creator changes "ask me first" and, through
  **Change limits**, the limits — the same table with only the limits
  editable, then a confirmation listing each change, before and after; its
  activity. **Replace key asks first**
  and states the one consequence: **the old key stops working at once** —
  there is no grace period; replacing a machine key is one act, so the
  machine is never left without a key nor with two. Stopping a mission,
  removing a teammate, leaving a mission and revoking a key cannot be undone
  and are confirmed by typing a name. The
  screen of creation must stay usable for a mission on three accounts
  without scrolling through a wall of checkboxes.
- **The activity of a mission** — its session: what waits, who called in the
  current period per key holder and per agent label, the timeline of its
  events, and, on demand, what each permission used and the counters of
  earlier periods. A key holder is authenticated; an agent label is what a
  caller said of itself, and the page says so.
- **Accounts** — the accounts I can use: **mine**, alone or through a team
  that owns them, with their state; **"Shared with you"**, the accounts a
  colleague gave me access to and the exact permissions each access holds;
  and the services I can connect ("Connect an account" starts the service's
  own authorization flow with the apps the administrator registered, or asks
  for the key the service issues; a field says the shape it expects). **On
  an account**, for its owners only: **who has access** and up to what;
  its resources with their environment labels (edit, refresh discovery);
  **the missions that use it and who created them, whoever created them** —
  because removing an access or disconnecting stops missions, and each
  confirmation says how many. An owner reads there the name, the creator and
  the state of such a mission and nothing else of it; the mission's own page
  stays its creator's and its teammates'. **"Give access" is a dialog** over
  the account: a person or a team, then the checklist of permissions with
  "select all", each with its severity and its reason one click away; before
  confirming, the dialog lists the missions without an owner that the access
  would bring back. Removing an access, handing the account to a team and
  disconnecting it are asked first; an owner may close a mission that
  stopped for want of an owner on their account.
- **Reference** — what an agent can do on each shipped plugin's service, for
  any signed-in user and read-only, in **three tabs**: **Permissions** — one
  table, the permissions against the presets, each cell the limits a preset
  gives and whether it asks first; a permission unfolds its reason, the six
  dimensions behind its severity, what it covers and the tools declared for
  it —; **Tools**; and **How it is modelled** (the data model and where the
  environment of a call comes from). Every permission shown elsewhere links
  to its entry here.
- **Activity** — the audit record: one line per call and per change a person
  made, newest first, with filters by period, mission, account, tool,
  decision, person, key holder, agent label and kind of entry. **Each line
  has a detail**, reachable by its own address: the key used, the
  permissions touched and what is left, what the agent was told. **Who reads
  what:** a user reads the entries of the missions they created, of the
  missions shared with them as a teammate, and of the accounts they own; an
  administrator reads every entry of the instance, calls included. **Nobody
  reads arguments there**: the audit never holds them, and the fingerprint
  that stands for them is shown only to who answers for the call — the
  creator of its mission, an owner of its account — never to a teammate or
  to an administrator as such.
- **Settings** — for everyone: the theme; the **second factor** (enrol one
  from a QR code and confirm it with a code, the recovery codes shown once,
  replace it, remove it after a fresh sign-in — never an administrator's);
  for a local account, its password; and
  **Connected apps**, the agents I allowed to prepare missions in my name:
  until when each consent runs, the missions each prepared, and its
  disconnection, asked first. For an
  administrator, **Administration**: a setup checklist of what the instance
  still needs; **sign-in** — the list of sign-in providers, each with its
  kind (OpenID Connect, GitHub, local accounts), its admission rule and
  the address to register at it, and whether it is on; an administrator
  adds, edits, tests, switches on and off and removes one, its secret never
  shown back, and a provider set by the configuration file is shown
  read-only and always on; local accounts are added in one step, on, and
  need no registration anywhere; Google and Entra ID are offered as
  presets of OpenID Connect that fill the form and say where to register
  the client. A provider added here is **off** until a test passed: the
  **test** runs the provider's sign-in in another window and signs nobody
  in — no person, no session, the tester's own untouched — then shows what
  the provider returned (subject, email and whether it is verified, groups,
  authentication methods) and the verdict a sign-in would get (admitted as
  administrator, as a user and why, or refused and why); from that result
  the administrator switches it on, and during the setup the holder of the
  setup link makes the tested identity the first administrator. An edit of
  a provider that is on keeps it on and marks its last test stale. The
  sign-in page offers only the providers that are on. Switching one off or
  removing it says how many people signed in through it: they can no
  longer sign in and their sessions end — never the administrator's own —,
  and their missions and connected apps keep the rules of a deactivation
  (they stop only when the administrator deactivates them); neither is
  allowed when it is the last way in of every administrator; **people** — everyone who signed in, with the provider
  they signed in through (deactivate, reactivate, make or unmake an
  administrator), the **administrators** (every person, pending address and
  group of a provider named administrator, and by whom: the setup, an
  administrator, the configuration at its first start, a recovery; an
  administrator names a group of a provider or removes a designation, and,
  when the configuration's rule differs from the one applied, the page says
  so and offers to apply it; an act that would leave no administrator a way
  in is refused), and the
  **invitations** (invite an address, remove one; removing it is asked
  first and stops the next sign-ins, not an open session; with local
  accounts, inviting sends the person the link that creates their account,
  or shows it to copy when the instance sends no mail, and the page can
  send it again, send a password reset, and reset a person's second
  factor — each asked first and audited); the page says
  that one person signing in through two providers is two people; teams (the
  local ones are kept here); accounts without owner (name a new owner — the
  administrator's only act on an account); registered apps (the OAuth
  clients of the management door: approve, disable); telemetry; and **the
  instance's name**, on the setup page, which an administrator sets or
  clears (clearing it brings back the host). The OAuth client a service
  needs before anyone connects it (§4.3) is not a page of Administration:
  the administrator declares it on that service's connect page, the one
  place to authorize a service (§7.2); the setup checklist names the
  services whose client is missing and leads there. Acts that stop,
  remove or hand over something are asked first. The public URL, the retention and the
  other keys of §4.3 are set in the instance configuration and shown in the
  interface, not edited there — except the instance's name and the
  telemetry opt-in, which the administrator sets in the interface unless
  the configuration sets them: a value the configuration sets is shown
  read-only, and the configuration wins. Every change made in the interface
  is audited.

Styling follows [style-guide](./style-guide.md).

### 4.3 Instance configuration

The operator provides, at installation, through environment variables or
a mounted file, never committing anything:

- the **master key** for encryption at rest — provided, or generated by the
  instance at its first start when the operator asks for it, in which case
  the setup hands it to the administrator, who confirms keeping a copy
  before anything else is set up; an instance never generates a key over a
  store that already holds data. An administrator can download the key
  again later, after a fresh sign-in; every download is audited;
- the instance's **public URL** (used for provider callbacks, request
  URLs, the bootstrap kit);
- the **sign-in providers**: zero, one or several, each with an id, a
  name, a kind (OpenID Connect, GitHub, or local accounts), its issuer (or
  GitHub's base URL), client identifier, client secret, claim mapping
  (subject, email, groups) for OpenID Connect, its allowed email domains
  and whether it admits invited addresses only; local accounts take an id
  and a name only, and are "invited only" by nature. The single-provider
  keys of earlier versions keep working as one provider. An open provider
  with neither allowed domains nor "invited only" is refused at startup and
  in the interface, with the reason;
- optionally, **mail delivery**: an SMTP relay (host, port, user,
  password, sender address, TLS) through which the instance sends its own
  mail — the links that create a local account or reset its password.
  Without it, local accounts still work: the links are shown to the
  administrator to hand over;
- for a provider that connects through the service's own sign-in only
  (`oauth2`: a service that offers no key a person can make — Gmail), the
  **OAuth client the company declared** at that service: identifier and
  secret, entered here or on the service's connect page (§7.2). Each
  instance declares its own client; the instance never uses one shared
  with another instance. Every other provider needs nothing here: people
  connect it with a key they make at the service (ADR
  [one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md));
- the operator's **bootstrap token**, the secret of the setup link: it
  opens the setup until the setup ends. Required while the configuration
  sets no sign-in provider; and an instance whose store names no
  administrator, with neither a token nor an admin rule, refuses to start;
- optionally, the **admin rule**: a group of a named sign-in provider
  (`<provider>:<group>`; a GitHub group is an organisation team,
  `org/team`) and/or a list of emails. It is a **seed**: applied once, at
  the start where the store names no administrator yet — each email an
  administrator at its first sign-in through any provider (at once for a
  user already known by it), the group a group of administrators — and
  never again by itself. A group matches only the members that provider
  claims: a group of provider A never satisfies a rule written for
  provider B. A group without a provider is accepted while one provider
  is configured, and refused once there are several. Without a rule, the
  setup names the first administrator;
- the **telemetry level** (off, plugin-health, plugin-health +
  usage-stats; §9) and the collector URL (default supplied,
  overridable, disableable);
- optionally, the instance's **name**: what the interface shows to tell
  this instance from another one of the same company (§4.2). From 1 to 64
  characters once the spaces around it are trimmed, without control
  characters; it is a label, never markup. When it is not set here, an
  administrator may set it on the Administration page; when neither sets
  it, the host of the public URL is shown instead.

Optional keys have defaults; among them the **absolute lifetime of a
delegation** (ninety days), the **audit retention** (ninety days) and the
git remote's **largest push** (200 MiB) and **longest request** (ten
minutes).

Anything missing makes startup fail with a message naming the variable.

### 4.4 Bootstrap kit after issuance

Inherited from v4 §12.4, adapted: after a mission is issued, the
interface shows its key, then three numbered snippets to copy — four when
the mission holds repositories the instance serves as a git remote — and a
verification command — the "setup kit" of the interface. The prose around
the snippets is in the interface's words; the commands, the variable name,
the MCP tool names, the refusal codes and the fields keep the protocol's.

1. The environment variable carrying the mission token. The secret is
   revealed once; the revisited kit shows its masked form, and the mission
   page offers "Replace key" (§4.2).
2. The client's MCP configuration (instance URL, authorization header by
   reference to the variable).
3. An instruction block for the agent: whose key it holds, connections
   carried, resource refs (and, for a connection issued whole, that
   resources found later are reached too), accepted risks, budget, what to do on each
   structured refusal (in particular: hand the request URL to the human,
   never try to work around it) and when the key itself stops working.
4. When the instance is the git remote of repositories of the mission
   (§4.1 ter): git's configuration — a credential helper that reads the
   variable (never a stored credential), the recommended rewrite of the
   provider's own git URLs to the instance, so that submodules and scripts
   go through the mission too — and the remote of each repository. The
   mission page shows the same remotes and what git may do under the
   mission: can, asks first, cannot.

A generic page served by the instance without authentication documents the
same for any agent, with no value of any mission.

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
  from the app registered by the company — and may declare other ways to
  connect, such as a token pasted by hand, each with its own form, check,
  resource discovery, the tools it cannot run, and a guide for the person
  (where to create it, which permissions to grant, the expiry to choose) —
  how to withdraw the grant at
  the provider when a connection is revoked (or, failing that, where a
  person removes it by hand), how to discover resources and which of
  their tools create one (the gateway discovers again after such a call
  succeeds), and ship at
  least one **preset** in their catalog. Contribution process:
  [CONTRIBUTING](../../CONTRIBUTING.md) and the plugin kit,
  [plugins/README](../../plugins/README.md).
- **The sign-in providers** — authenticate humans, provide subject,
  email (verified) and, for a company directory, groups. The instance
  trusts each for the identities of its own issuer only, never for
  authorization: shares and missions are local, and admission is the
  instance's (allowed domains, invitations).
- **Providers** — a key a person makes at the provider and pastes, or,
  where the provider offers none, the company's own OAuth client. The
  authorization flow runs between the user, the provider and the
  instance; no third party.
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
  lives in the store, and leaves the process environment once the
  configuration is read. Rotating it seals every stored secret again
  under the new key, after which the previous key is removed: a leaked
  key stops opening the current store.
- **No credential to the executor.** Invariant §2.4.
- **Transport.** The instance exposes plain HTTP on the local network and
  requires being placed behind a TLS termination held by the company.
  The configured public URL must be HTTPS; provider callbacks and
  request URLs carry it.
- **Human authentication.** Delegated to the sign-in providers. Each
  sign-in attempt carries its own `state`, nonce and PKCE verifier and
  is bound to the provider that started it: a response for provider A
  never completes an attempt started for provider B. A sign-in is
  admitted only on an email the provider verified, matching that
  provider's allowed domains, the invitation list or the administrators
  (the person, a pending address for that provider, or a group the
  provider claims the person a member of) — or, for a tenant provider
  without allowed domains, any user of the tenant. An unverified email never admits and never makes an
  administrator; a tenant provider may be configured to require the
  provider's verified-email signal too. **Local accounts** hold their
  password hashed with a memory-hard function (argon2id); a wrong password
  is answered like an unknown address, the sign-in form is rate-limited and
  an account is locked for a while after repeated failures. **Every
  sign-in**, through any provider, ends with the instance's **second
  factor** before the session exists — a time-based one-time code never
  accepted twice, or a recovery code used once; enrolled at the person's
  first sign-in —, unless an administrator waived it for that provider
  (outright, or when the provider's token says it asked a second factor of
  its own), and never waived for an administrator. **Recovery by the master key**: a
  page reachable without a session lets whoever holds the instance's
  master key name one administrator — an existing person, an address
  through a provider, or a group of a provider — and nothing else; the key
  never leaves the browser (the page proves holding it against a
  single-use challenge, and the instance checks the proof with the key it
  holds), and the naming is recorded, mailed to the administrators when
  the instance sends mail, and shown on every page for thirty days; the links that create an account or reset a
  password are single-use, expire in minutes and are known to the store
  by their digest only; password hashes, second-factor secrets and
  recovery codes are sealed under the master key, and none of them reaches
  a log, the audit or the telemetry. Web sessions are short (an
  absolute lifetime and an idle timeout) and bound to the instance's
  origin; a person, or an administrator for them, can end every session
  of that person at once. Every mutation requires a valid session and an
  origin check. **No self-lockout**: unmaking an administrator,
  deactivating a person, switching off or removing a sign-in provider are refused when they
  would leave no administrator with a way in (an active administrator whose
  provider is configured); removing a provider ends its users' sessions,
  never the remover's own. The sign-in endpoints are rate-limited like every other
  anonymous surface.
- **What a provider says stays with the agent.** A provider's error text
  reaches the calling agent only; the instance logs, stores and shows the
  provider's status in its own words.
- **Browser hardening set by the instance itself.** Every response carries
  the security headers — a Content-Security-Policy that admits only the
  instance's own scripts (a per-request nonce) and forbids framing,
  `nosniff`, a same-origin referrer policy, a permissions policy that
  grants no device, and HSTS when the public URL is https — so that a
  deployment behind any TLS terminator has them; the reference proxy
  adds none that conflicts.
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
- **Declaring the OAuth client of a service** is an administrator's act,
  on the service's connect page: its secret goes straight to the
  encrypted settings, is never shown back and never logged; the audit
  records who changed which client (its identifier), never a secret.
- **A pasted token is checked at the service before it is stored**, and a
  call the service refuses for a permission the token lacks is reported as
  such, naming what the token needs; the gateway sends the token as it
  is and narrows nothing itself — the mission's decision is what narrows
  a call.
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
  operator-configured retention. The same retention purges the session
  history — timeline events and the counters of past periods — and never
  what the budget of the current period is computed from.
- **Leak-free telemetry.** See §9: no argument, no resource ref, no
  stable instance identifier.

## 7. Workflows

### 7.1 Install an instance

The operator deploys the image, provides the configuration (§4.3), opens
the interface with the bootstrap token — typed, or carried by a setup link
whose fragment holds it, so that the token reaches no log —, downloads the encryption key when
the instance generated it and confirms having kept it, and names the first
administrator: with local accounts, the setup creates their account — any
address, a password; the second factor and the recovery codes at its first
sign-in —; with a provider of the company, the configuration's admin rule
names them at the first start, or a passed test of the company's provider
makes the tested identity the first administrator. They add a sign-in
provider (or declare it in the configuration), test it and switch it on,
invite the addresses an open provider should admit, and **finish the
setup**: an explicit step, allowed once the key was handed over and an
administrator has a way in, that revokes the bootstrap token — no sign-in
revokes it by itself. Nothing else stands between them and the first
account: a service that signs people in through an OAuth client (Gmail) is
declared on its connect page the first time someone opens it; every other
service is connected with a key.

### 7.2 Connect an account

A user opens Accounts, picks a service under "Connect an account", and
lands on the one place that authorizes it. The page guides them through
the simplest way the service offers (ADR
[one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md)):
a key the person makes at the service and pastes, whenever the service
lets a person make one, with a guide derived from the plugin — where to
create it, which permissions to grant for the plugin's tools, the expiry
to choose, and that a shared service account is fine; or, for a service
that offers no such key (Gmail), the service's own sign-in: the person is
sent to the service, consents and comes back. That second way needs the
company's OAuth client declared at the service once; an administrator
does so on the same page, before anyone connects, and the page tells
everyone else who to ask until then. A pasted token is checked at the
service before it is stored (who it acts as, its expiry when the service
says), is never shown back, and its expiry is shown on the account's page
ahead of it; a token the service rejects makes the account "needs
reconnecting". An account connected a way the service's plugin no longer
offers (an earlier build) runs nothing until its owner reconnects it.
Removing an account withdraws the grant at the service where the service
offers a way for it, and otherwise says where to delete the key there.
The connection — the account — is created, encrypted, under their name. The plugin discovers its resources; the owner labels their
environments. They are its owner. They may then hand it to a team they
belong to; every member of the team becomes a full owner, and so will
members who join it later.

### 7.3 Give access

On the account, the owner opens "Give access", picks a person or a team,
ticks the permissions, confirms: this is a share. The target sees the
account under "Shared with you" and may create missions within that bound.

When the access would ground orphaned missions again — they would serve
calls at once, with the key their agent still holds — the dialog lists
those missions, each with the person who created it, and the access is given
only once the owner has confirmed that list.

### 7.4 Create a mission

The creator names the mission, picks its accounts and, within each, the
resources it may touch, picks one preset per account (a plugin's, or
"Everything I hold on this account" for a mission as wide as their
authority), reads the summary,
opens the permissions one by one only if something needs adjusting within
what they may allow, sets how often the limits reset and when the mission
ends. A mission has no expiry unless its creator gives it one: the form's
default is "never". Before the mission exists, the creator reads and
confirms the explicit list of its permissions with their limits. The key is
revealed once. The setup kit is displayed.

### 7.5 Execute

The agent calls the gateway. On the first call, the session is born.
Every allowed call decrements the counters of the risks touched and
produces an event and an audit entry.

### 7.6 Exhaust and claim

A call touches a risk at zero quota. The `budget-exhausted` refusal
carries the claim URL. The human steering the agent opens it, or forwards
it to the creator, who also finds it under "Waiting for you", on the home
and on the mission. The creator authenticates, sees what was used and what
is left, decides. The agent replays. When the limit itself was wrong, the
creator changes it on the mission (§3.2) rather than answering again each
period.

### 7.7 Approve an action

A call touches a risk gated `approval`. The `approval-required` refusal
carries the request URL. The creator sees it under "Waiting for you",
opens the request, reads the tool and the arguments there, grants. The
agent replays the same call; it
passes and consumes the approval. If the agent changes the arguments, a
new request.

### 7.8 Revoke and rotate

The creator stops a mission (a revocation, for good) or replaces its key
(a rotation) without changing the mission; replacing asks first, and the
old key stops at once. The owner removes an access or disconnects an
account; the missions that use it lose that account only and keep running
on their others, those that used nothing else become `orphaned` and refuse
everything, with the reason, and the confirmation says how many. The
mission's page says which account it lost and whether it comes back (never,
for a disconnected one); its creator issues a new mission to reach the
account that replaced it. Nothing is ever added to a mission in a lost
account's place.
When a connection is revoked, the owner is told what became of the
access granted at the provider: withdrawn there too, or theirs to remove
by hand, with the place to do it.

### 7.9 Work with several agents

An orchestrator that spawns sub-agents hands them its MCP configuration
as is. They present the same mission token. Each may set its agent label
on its calls so that the session and the audit tell who did what. The
budget is shared.

### 7.9 bis Work on a mission as a team

The creator adds colleagues as members of the mission — teammates. Each
signs in, finds the mission under "Shared with you", and generates their
own key, shown once, with the setup kit. Every call is then attributed to
its holder in the session and the audit. For a machine with no account, the
creator creates a named token — a machine key. Any key is revoked on its
own, by its holder or by the creator. A teammate may leave the mission by
themselves; their key stops at once, as if the creator had removed them.
Requests still go to the creator, who alone answers them; a teammate sees on the mission that it waits, and for
whose answer.

### 7.10 Have an agent prepare a mission

A user connects their agent to the management surface; the OAuth flow
sends them to the instance, they authenticate through the IdP, consent,
and the agent receives a delegated token. The agent reads the user's
authority and the catalog, composes a policy from the task described,
previews it, fixes what exceeds, issues the mission. The user sees it
appear under their name, marked as prepared by that connected app. The
agent, or another one, executes the mission with the mission token
received. The requests that follow wait for the user, and only they answer
them.

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
revocation, issuance, extension, reset, approval, rotation, change of
limits, a mission orphaned or restored, a mission that lost an account or
got it back — naming the human whose act did it —, a member removed or leaving, delegation granted or revoked,
an administrator named or removed, the configuration's admin rule applied,
a sign-in provider tested, switched on or off, a second factor enrolled,
reset or waived for a provider, an administrator named with the master key,
configuration change), object, previous and new
state when meaningful, and, when the act comes from the management
surface, the identity of the delegated client.

An entry is read by the creator of its mission, the current members of
that mission, the owners of its connection, and the operators (§4.2
"Audit"). A member who is removed stops reading the mission's entries,
past ones included.

Retention configured by the operator, 90 days by default. No cold archive
in v5.

The retention covers the session as well as the audit: an event of a
session's timeline older than the retention is deleted, and so are the
counters of a period that ended longer ago than the retention. What the
current period rests on is kept whatever its age: its counters, the gates
opened until it ends, and the credits granted claims gave back in it. A
one-off mission has a single period that never ends, so its counters stay
for as long as the mission does.

## 9. Community telemetry

Plugins cannot be tested against real providers in the project's
automated suite. Trust comes from usage.

> Amended on 2026-10-16 (ADR
> [telemetry-two-levels-behind-a-vercel-collector](../decisions/telemetry-two-levels-behind-a-vercel-collector.md)):
> the report is widened to everything that carries no secret, no identifier
> and no payload, in two levels. The receiving side is specified in
> [website](./website.md) §3.

- **Opt-in per instance**, disabled at installation, enabled by the
  operator, visible in the interface. Three settings: **off**,
  **plugin-health**, **plugin-health + usage-stats**. The first version may
  offer only off and the last one; the wire keeps the two levels apart from
  the start so that the choice can be offered without a new format.
- **Level `plugin-health`** — one report per call a plugin executed: plugin
  identifier, plugin version, gateway version, tool name, outcome
  (`success`, `upstream-error`, `classification-error`, `execution-error`),
  normalized error class, duration bucket (`<100ms`, `<1s`, `<10s`,
  `>=10s`).
- **Level `usage-stats`** — in addition:
  - one **decision report** per call the gateway decided, executed or
    refused: plugin identifier, tool name (only if the plugin declares it),
    gateway version, decision (`allowed` or the refusal code of §4.1), the
    `RiskId`s the call touched **without their environment qualifier**
    (environment labels are chosen by the company), and whether a gate
    applied (`approval`, none);
  - one **instance profile** per UTC day: gateway version, deployment kind
    (`docker`, `railway`, `fly`, `other`), runtime version and architecture, the
    plugins enabled with their versions, the kinds of sign-in providers
    configured (`oidc`, `github`), and bucketed counts (users, accounts per
    plugin, active missions, calls of the day). It carries a **day
    identifier**: random, drawn again each UTC day, held in memory only,
    sent with the profile and with nothing else. It counts the reporting
    instances of a day; it cannot follow an instance from one day to the
    next or join a profile to a call.
- **No report carries a time.** The collector stamps the arrival, truncated
  to the UTC hour.
- **Never**, at any level: arguments, argument hashes, payloads, provider
  responses, error text, resource refs, environment labels, mission
  identifiers, user identifiers, emails, account names, host names, URLs,
  a stable instance identifier, a network address. Every field is a value of
  a closed vocabulary, a shape bounded by the plugin's own declaration, or a
  bucket. A structural test checks every report shape (§10).
- **Public aggregation**: success rate per `(plugin, version, tool)` and the
  number of reporting instances per day. A plugin is **deemed validated**
  above a success threshold and a minimum number of reports, both
  published. The instance's interface shows this status in the details of
  each account and in the reference of its service. Usage statistics are
  readable by the project's maintainers; publishing their aggregates is an
  open question of [website](./website.md) §5.
- The collector is hosted by the open source project, never stores a
  network address, and stores no field a report does not define
  ([website](./website.md) §3). The content of each level is published on
  the project's trust center, word for word.

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
    request, are refused unambiguously;
  - local accounts (§6): the password hash is argon2id and verifies the
    password only; the lockout counts wrong passwords per account across
    restarts; a one-time code is accepted once, within one step of drift;
    a recovery code once; a link once and before its expiry; an unknown
    address and a wrong password get the same answer; no secret in a log,
    an audit entry or a telemetry report;
  - the administrators (§0, §6): the configuration's rule applied once
    while the store names nobody — an upgraded instance keeps every
    administrator of its email or group rule —, a changed rule naming
    nobody by itself, a pending address consumed by the first sign-in of
    its provider, and every act that would leave no administrator a way in
    refused;
  - the second factor (§6): enrolled at the first sign-in through any
    provider and asked at every one after, before the session; waived for
    a provider outright or on its token's `mfa`, never for an
    administrator; the factor of an earlier local account moved to its
    person;
  - the recovery by the master key (§6): the browser's proof equal to the
    instance's, a wrong key and a replayed challenge refused, the recovery
    session naming one administrator and nothing else, the entry, the mail
    and the banner of thirty days;
  - the test of a sign-in provider (§4.2): no user, session or group written,
    the tester's session kept, a callback of another session refused, the
    verdict computed as a sign-in would, the result usable by the tester's
    session only; a provider saved off and switched on only after a test
    passed since its last save, refused at sign-in while off;
  - the OAuth client of a service (§4.3, §7.2): declared on the connect
    page by an administrator only, the file winning over the page, the
    secret sealed and never echoed, an audit entry without a secret, the
    page saying who to ask until it is declared.
- **Integration**, on an ephemeral instance with embedded store and
  simulated IdP: connection, share, issuance, claim, approval and
  replay, revocation flows, the git remote with the real `git` client
  against a local git server standing in for the provider (multi-ref
  pushes, claimed ref values, malformed requests included), `orphaned` states, OAuth delegation then
  issuance of a mission by an MCP client within the user's authority and
  refusal beyond it.
- **End to end, acceptance criterion for the cutover**: connect the
  providers the team actually uses, issue one mission per code project,
  run the daily workflow with a coding agent with no unexpected refusal.
  Described in [e2e-tests](../tests/e2e-tests.md). Run by hand, outside
  the automated suite.
- **Structural**:
  - no telemetry report, of either level, contains a forbidden field
    (§9), and the day identifier travels with the instance profile only;
  - session counters agree with the audit;
  - no configuration value is hard-coded;
  - every persisted restriction and `accepted_risks` is an enumerated
    list, never a wildcard, never a preset reference;
  - every plugin ships at least one preset, and every preset references
    only `RiskId`s of its own catalog;
  - a user's authority on a connection is recomputed from their current
    group membership, never from a snapshot;
  - the git remote admits with the execution door's own admission.
- **Out of scope**: integration tests against real providers.

## 11. v1 decisions & open questions

### 11.1 Settled decisions

- One instance, one company, one trust domain.
- Human identity through OpenID Connect, GitHub's OAuth sign-in, or the
  instance's own local accounts with a second factor (ADR
  [local-accounts-sign-in-provider](../decisions/local-accounts-sign-in-provider.md)).
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
- The instance is its own authorization server for the management door
  and relies on the IdP for identity only (ADR
  [management-door-authorization-server](../decisions/management-door-authorization-server.md)).
- A member works under the creator's authority and needs no share of the
  mission's connections; they see the whole session of the mission and
  its audit entries, never arguments nor their fingerprint, and requests
  stay the creator's (ADRs
  [mission-members-and-per-holder-tokens](../decisions/mission-members-and-per-holder-tokens.md),
  [audit-visibility-members-and-operators](../decisions/audit-visibility-members-and-operators.md)).
- One connection per provider in a mission; no default expiry; the
  surface rate limit is per mission; a loopback-only client needs no
  operator (ADR
  [owner-decisions-of-2026-10-13](../decisions/owner-decisions-of-2026-10-13.md)).
- A request and an approval each expire after a delay the operator
  configures (twenty-four hours and ten minutes by default); a request
  on a mission that can no longer be granted expires on the same delay
  (ADR
  [request-expiry-on-orphaned-missions](../decisions/request-expiry-on-orphaned-missions.md)).
- No v4 migration; a one-shot import of each organization, then the cutover.
- A connection's owner is a principal, user or group; a mission always
  has a user creator.
- Presets are shipped by plugins, one per connection at issuance, UI
  sugar only; the persisted policy is always explicit, and the creator
  confirms that explicit list before the mission exists.
- The interface has its own words for people (§0, "Words"); the protocol's
  names do not change (ADR
  [interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md)).
  Replacing a key has no grace period (ADR
  [mission-pages-confirm-the-explicit-list-and-ask-before-a-key-stops](../decisions/mission-pages-confirm-the-explicit-list-and-ask-before-a-key-stops.md)).
  An owner of a connection reads the missions that carry it and who holds
  it, by name (ADR
  [owner-reads-missions-and-holders-of-a-connection](../decisions/owner-reads-missions-and-holders-of-a-connection.md)).
- Resources belong to the connection, labelled with an environment by
  the owner; a mission selects a subset per connection (all by default)
  and is refused outside it.
- After the setup, the operators are the administrators the instance
  keeps in its store; the configuration's admin rule is a seed applied
  once, while the store names nobody (ADR
  [administrators-live-in-the-instance](../decisions/administrators-live-in-the-instance.md)).
- Several sign-in providers per instance, OpenID Connect and GitHub;
  identities never merge by email; admission by allowed domains, an
  instance-wide invitation list and the admin rule (emails and group), an
  open provider always needing one of them; the admin rule's group names
  its provider;
  the instance sets its own security headers (ADRs
  [sign-in-providers-admission-and-admin-rule](../decisions/sign-in-providers-admission-and-admin-rule.md),
  [github-sign-in](../decisions/github-sign-in.md),
  [security-headers-set-by-the-application](../decisions/security-headers-set-by-the-application.md)).
- One place to authorize a service: a key the person makes and pastes
  wherever the service offers one; the company's own OAuth client, declared
  on the service's connect page, only where it offers none (Gmail). The
  GitHub App, its manifest flow and the OAuth apps of Supabase and Railway
  were removed on 2026-10-20 (ADR
  [one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md)).
  Every instance declares its own OAuth client, never a shared one.

### 11.2 Open questions

What is listed here is not decided, or is a v1 assumption that usage may
overturn. A question an ADR settled is in §11.1.

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
- **Transitive sharing.** May a beneficiary re-share a connection to a
  third party within their restriction? v1 assumption: no, only the
  owner shares.
- **Notifying the creator.** In v1 "Waiting for you" in the interface — on
  the home, on the mission and in the navigation's count — is enough, plus
  the URL the executor hands over. Is an optional outbound
  channel needed (webhook, mail through the company's server)? Operator
  decision, ADR if added.
- **Gate in shares.** May a share's restriction impose `approval` on some
  risks for the beneficiary's missions, with approval by the connection
  owner rather than the creator? v1 assumption: no, the gate lives in the
  mission, like quantities.
- **Resources in shares.** A share's restriction is a list of `RiskId`.
  Should the owner also be able to restrict a share to some resources of
  the connection? v1 assumption: no, resource selection lives in the
  mission; the beneficiary's missions may touch any resource of the
  connection within the risks shared.
- **Agent label.** How an MCP client transmits it (header, protocol
  metadata field) and whether the orchestrator can impose it on its
  sub-agents. No effect on authorization, hence decidable at
  implementation.
- **Scope of the management surface.** Limited to missions in v1. Should
  it include sharing connections, so that an administration agent also
  prepares a team's shares? v1 assumption: no, sharing stays a human
  gesture.
- **Automatic policy proposal.** The surface exposes reading and preview;
  composing a policy from a natural-language task is the client's job,
  not the instance's. Plugin presets are the instance-side help; the
  management surface exposes them.
- **Per-tool discovery.** `tools/list` filters per provider (§4.1).
  Should plugins declare, per tool, the risks it can touch, so that a
  mission lists only what it can call?
- **Audit export.** Format and scope of an export for companies subject
  to retention requirements beyond local retention.

---

_Date: 2026-10-12; §0 "Words", §4.2, §4.4 and §7 aligned with the redesigned
interface on 2026-10-14; several sign-in providers, invitations and the
admin rule across providers on 2026-10-14; local accounts, the second factor
and mail delivery on 2026-10-19; the administrators kept by the instance on
2026-10-20. Author: rpelissier + Claude (drafting). Status:
draft v5 for review._
