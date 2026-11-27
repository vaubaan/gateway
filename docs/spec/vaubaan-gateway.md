---
title: Vaubaan Gateway (v5) — on-prem MCP gateway with budgeted missions
status: draft
---

# Vaubaan Gateway — spec

> **Status:** draft v5 (founding ADR
> [pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)).
> _Which_ risk a call touches is [gateway-risk-model](./gateway-risk-model.md); this spec says _who_
> may accept _which_ risk, _how many times_, _how fast_, _under whose eyes_, on which instance.
>
> **History:** 2026-10-31 — the trust level (Careful, Trusting, Autonomous) and the tier got their
> English names before publication, a breaking rename in the alpha window (owner decision,
> recorded in the History of
> [macro-actions-and-trust-levels-prefill-the-policy](../decisions/macro-actions-and-trust-levels-prefill-the-policy.md)).
>
> 2026-11-13 — the tier became the row of a decision tree over five facts, and the severity word
> left the product: a permission is shown with its row and the reason of the row
> ([gateway-risk-model](./gateway-risk-model.md) §4.6, same ADR, amendment 2026-11-13).
>
> 2026-11-14 — confirmations only before an irreversible act (owner decision): creating and
> editing a mission ask nothing (§4.2, §7.4); a plugin may hide at discovery what the credential
> can only read (§0 Resource).
>
> 2026-11-22 — a mission may carry several accounts of one service; a call runs with the account
> holding the resource it names, or the one the agent names with `vaubaan_account` (§3.1, §4.1; ADR
> [one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md),
> amendment 2026-11-22).
>
> 2026-11-22 — the vision speaks to one person first, then the team, with the promise, its three
> pillars and the moments that decide adoption, from the product research (owner decisions of
> 2026-11-19 and 2026-11-20; §1).

## 0. Vocabulary

**One word per thing** (ADR one-word-per-thing-account-service-plugin). Three words are the same
in the interface, the code, the store and the protocol:

- **account** — your account at a service, plugged once into the instance (the full form "your
  account at a service" in definitions only; never "service account", which names a robot
  identity on cloud platforms). The instance's own password accounts are **sign-in accounts**.
- **service** — the third-party product a plugin connects to (a code host, a mailbox…); a sign-in provider stays
  explicit (IdP).
- **plugin** — only the code package: installed, pinned, built with the SDK, with its reference
  page. The **catalog** is the public list every published plugin comes from; an instance has none
  of them until it installs one; a plugin is shown with its **signer**, what its verified signature says
  of who built it: signed by Vaubaan, by a signer the instance trusts, or not signed (§5).

**Deployment**

- **Instance** — one deployment, owned and operated by one company on its own network. A single
  trust domain: no tenant, org or project.
- **Operator** — who installs, configures and maintains the instance: during setup the holder of the
  bootstrap token (the setup link), afterwards the administrators. Access to the configuration, not
  to others' missions.
- **Administrator** — a user the store names as such: a person, an address awaiting its first
  sign-in through a sign-in provider, or a group of a named sign-in provider (every member it claims). Named
  by the setup, by another administrator, once by the configuration's **admin rule** while the store
  names nobody, or by the master key's holder through recovery. A later change of the rule names
  nobody by itself: it is shown, and an administrator applies it or not.
- **Sign-in provider (IdP)** — where the instance delegates human identification: the company
  directory (OpenID Connect), a public service where people hold their own accounts (OpenID Connect,
  GitHub), or the instance's **sign-in accounts**. Several at once, each with an id, a name and its
  own admission rule.
- **Sign-in account** — an email and a password kept by the instance, for a company without a
  directory. A sign-in provider kind of its own (at most one), always invited-only: an account exists only
  for an invited address or an administrator, created through a single-use link, or by the setup for
  the first administrator. The instance stores no other password.
- **Second factor** — a one-time code from an authenticator app (recovery codes shown once), asked
  at the end of every sign-in through any sign-in provider, enrolled at the first. An administrator
  may waive it for a sign-in provider whose directory enforces its own (outright, or only when it says
  it asked one), never for an administrator.
- **Open sign-in provider** — one where anyone can hold an account: it admits only through allowed
  email domains or the invitation list. A tenant sign-in provider (the company's directory) may admit
  everyone its directory authenticates.
- **Invitation** — an email an administrator allowed to sign in, instance-wide, through any
  sign-in provider that verified it. Administrators need none.

**Identities**

- **User** — a human authenticated by a sign-in provider, identified by (issuer, subject), displayed
  by email. **Identities never merge by email**: one person through two sign-in providers is two users.
- **Group** — a named set of users, from sign-in provider claims or else a local table kept by the operator;
  names are unique across both sources, and a group is never deleted. Can own an account and be
  the target of a share; never creates a mission.
- **Principal** — a user or a group, where a rule applies to both.
- **Vaubaan account** — a user's own account of the `vaubaan` plugin, the gateway's management
  tools as a service: created in one click, holding no secret, owned by that user alone and never
  shared. A mission on it lets an agent prepare missions in the creator's name (§4.1 bis). It
  replaced the delegations of the retired management door (ADR
  platform-management-is-a-plugin-on-the-execution-door).

**Accounts and authority**

- **Service** — a cloud service supported by a plugin, described by its risk catalog.
- **Account** — your account at a service, plugged into the instance by a user: with a
  key the user made at the service and pasted (a token or an app password, often of one shared
  machine user: the
  instance decides who does what, the audit says who did), or, where the service offers no such
  key, through its own authorization flow. Each plugin declares one way. Holds the long-lived
  credentials, encrypted at rest. Its owner is a principal: its creator, who may transfer it to
  a group they belong to.
- **Owner** — the principal an account belongs to: the user who connected it, or a group they
  transferred it to, every member of which is then an owner. Only an owner shares, reconnects,
  transfers or revokes the account, and labels its resources.
- **Resource** — one thing reachable through an account (a repository, a database project…).
  Discovered by the plugin when the account is connected, on demand, right after a gateway call that created one
  (the plugin declares which calls create; the refresh never delays the answer), right after a call
  that listed resources the account may not know yet (a project's preview branches; the plugin
  declares which calls reveal, and such a call adds nothing to the mission by itself), and **on its own**:
  every account in use is refreshed once an hour (`accounts.refresh_interval`, §4.3), and again when
  a page shows it and its last refresh is older than 15 minutes. The same refresh asks the service
  again what the key may do and until when. Nobody needs to press "Refresh"; it stays, small, for
  right after a key's scope was changed at the service. A refresh that changed nothing leaves no
  trace in the record. The
  owner labels each with an **environment** (`prod`, `staging`…) and may give the account a
  **default environment**, carried by every resource without its own label, later ones included; a
  resource's own label wins; setting or clearing the default is an audited owner act. Where the
  service itself decides the environment, the plugin sets the label at discovery and the owner
  cannot change it: a project's preview branch is `preview`
  ([preview-branches-are-discovered-resources](../decisions/preview-branches-are-discovered-resources.md)).
  Environment-qualified `RiskId`s resolve against the label of the resource a call touches (or,
  where the environment lives in the arguments, the plugin derives it). An environment-scoped risk
  on a resource with no label, or a label outside the risk's environments, is refused. The owner may
  rename or hide a resource; a refresh keeps names, labels and hidden marks, and marks stale what
  discovery no longer returns. A plugin may discover a resource hidden when the credential most
  likely cannot act on it (a public repository outside a token's grant); once the owner hides or
  shows it, the owner's choice stays. "Every resource known" excludes hidden and stale ones; selecting a
  stale one is refused at issuance.
- **Environment** — a label the owner gives a resource (`prod`, `staging`…), a lowercase slug, or
  the account's default environment for resources without their own. An env-scoped risk is
  accepted per environment and resolved, per slice, from the call or the resources it names
  ([gateway-risk-model](./gateway-risk-model.md) §4.4, §6).
- **Share** — the owner grants a target (user or group) a **restriction** on the account.
- **Restriction** — an explicit enumeration of `RiskId`s of the service's risk catalog: the upper bound
  of what the target may accept in their missions. Never a wildcard; empty authorizes nothing.
- **RiskId** — identifier of an entry in a service's risk catalog (`github.merge-protected`);
  [gateway-risk-model](./gateway-risk-model.md) §4.

**Missions**

- **Mission** — a named objective for which a user issues a token. Carries one or more accounts
  and, within each, the resources it may touch, a closed set of accepted risks, a budget, an
  optional recurrence and an optional expiry. A mission does not expire unless its creator sets an
  expiry. Its name is at most 120 characters; a recurring period lasts 60 seconds to 366 days.
- **Mission member** — a user the creator gave access to the mission, to work on it under their own
  name, as it is: reads it, manages their own token, may leave; cannot change it, answer its
  requests or add members. The creator is a member by construction and cannot leave: they revoke.
- **Mission token** — the Bearer an executor presents. A mission has one or more; each identifies
  one mission and one holder, as a member token or a named token. All draw from the same budget. A
  call may carry a free-form **agent label**, copied into the audit, with no effect on
  authorization.
- **Member token** — a mission token a member generates for themselves; the creator never sees it,
  and it stops when the member is removed or deactivated.
- **Named token** — a mission token the creator makes for something without an account (a CI
  runner), named in 1 to 60 letters, digits, spaces, dots, dashes or underscores (never an `@`).
- **Mission policy** — the table `RiskId → (budget, gate)`: which actions, in what quantity, whether
  a human validates each.
- **Budget** — what a mission policy allows of one accepted risk: a quota and a rate limit.
- **Quota** — how many actions of one risk a mission may run per period; when it is spent, calls
  are refused until the next period or a granted claim.
- **Rate limit** — how many actions of one risk a mission may run in a short sliding window,
  bounded by the risk catalog's per-minute ceiling.
- **Macro-action** — what an agent may do on one account, in the connector's own words ("Read",
  "Change", "Administer"): a group of `RiskId`s of one risk catalog, each with a base budget
  ([gateway-risk-model](./gateway-risk-model.md) §4.6). Every account also offers "Anything else"
  (the fallback). A creator ticks macro-actions and sets each to a **trust level** (Careful, Trusting,
  Autonomous), which pre-fills the gate and budget of each of its risks from the risk's row. It
  grants nothing, is bounded by the creator's authority, and only the explicit lines it wrote reach
  the token. Every account also offers the built-in expansion **"Everything I hold on this
  account"** (`everything-i-hold`, §3.2).
- **Trust level** — how far a creator trusts an agent with one ticked macro-action: **Careful**
  (the default), **Trusting** or **Autonomous**. It pre-fills the gate of each of its risks from
  the risk's row and multiplies their base budget ×1, ×3, ×10
  ([gateway-risk-model](./gateway-risk-model.md) §4.6). It grants nothing; the mission keeps it
  only to redraw the form. Only a macro-action has a trust level: a plugin has a **signer**.
- **Gate** — `auto` (passes within budget, the default) or `approval` (each action approved by the
  mission creator before it runs).
- **Period** — for a recurring mission, the interval after which quotas restart from zero. A one-off
  mission has one period, never renewed.
- **Mission log** — the living history of a mission, created on the first call with one of its
  tokens: every event, and the remaining budget. At most one per mission; spans periods. Not a
  **web session**, nor the MCP transport's session of an agent's connection
  ([the-missions-session-becomes-the-mission-log](../decisions/the-missions-session-becomes-the-mission-log.md)).
- **Web session** — a person's signed-in visit to the interface, opened by a sign-in and ended by
  sign-out or expiry (§6); "session" alone in §6 means this.
- **Event** — an allowed call, a refused call, or an administrative act on the mission. Call events
  are also audit entries.
- **Request** — a message from the executor to the creator, in the creator's inbox, referenced by a
  URL in a refusal or returned by a deliberate permission request. Only the creator answers. Three kinds: claim, approval request, permission request.
- **Claim** — a request raised when a quota is spent: the creator resets the budget or extends it.
- **Approval request** — a request for one call that touches a risk gated `approval`: the creator
  grants or refuses that precise call, however many gated risks it touches.
- **Permission request** — a request an agent raises after a missing-permission refusal, asking
  the creator to add the permission to the mission (§3.3 bis).
- **Approval** — the grant of an approval request, bound to the mission, the tool and the exact
  fingerprint of the arguments, covering every gated risk of that call; single-use, short-lived.
- **Notification** — a short message the instance sends a person outside the interface, saying that
  something waits for them or stopped without them. It names, never decides: a yes is given in the
  interface only.
- **Channel** — where a person receives notifications: a **device** (a copy of the interface
  installed on their phone or computer, subscribed from that device), a **messaging address** (the
  incoming address of a company messaging service, pasted by the person) or their **mail**.

**Cross-cutting**

- **Gateway** — the instance's MCP endpoint: classifies, decides, mints an ephemeral upstream
  credential, forwards, audits.
- **Audit** — one immutable entry per MCP call, allowed or refused, and per administrative act (§8).
- **Plugin report** — an anonymous, opt-in report of a tool's outcome to the community collector
  (§9).
- **Archive** — the one file a plugin version ships as: the built plugin, its risk catalog, the
  digests of its files and its signature; what an administrator uploads or installs (§4.2, §5).
- **Catalog** — the public list every published plugin comes from: one reviewed declaration per
  plugin (its source and exact revision), rebuilt from source and signed by Vaubaan (§5). Not to
  be confused with a service's **risk catalog**, the list of its risks
  ([gateway-risk-model](./gateway-risk-model.md)).
- **Signer** — who signed an archive: the catalog (shown "signed by Vaubaan"), or a key the instance's
  administrators named as trusted, such as a company's own key for its private plugins (§5).

## 0 bis. Interface words

For the other words, tool names, refusal codes, `RiskId`s, risk catalogs, API fields and configuration
keys spell the protocol's words, and so does this spec where it states a rule. The interface speaks
its own words; §4.2, §4.4 and §7 use them:

| The interface says                               | The protocol and this spec say                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| access — "Who has access", "Give access"         | share; the list of permissions an access holds is its restriction                  |
| "Shared with you"                                | shares received; missions one is a member of                                       |
| permission (its id stays visible, in mono)       | risk, `RiskId`                                                                     |
| limits, per period and per minute                | budget: quota and rate limit                                                       |
| runs freely / ask me first                       | gate `auto` / `approval`                                                           |
| key, your key                                    | mission token, member token                                                        |
| machine key                                      | named token                                                                        |
| Replace key                                      | rotate                                                                             |
| Waiting for you (a yes to give, a limit reached) | request: approval request, claim; the request inbox                                |
| Vaubaan account                                  | the account of the `vaubaan` plugin, a host account                                |
| Activity                                         | audit; the mission log                                                             |
| teammate                                         | mission member                                                                     |
| team                                             | group                                                                              |
| administrator                                    | operator                                                                           |
| OAuth client; Reference                          | the OAuth client the instance registers at a service; the reference of each plugin |
| stopped; without an owner; needs reconnecting    | `revoked`; `orphaned`, `unowned`; `expired` (of an account)                        |
| setup kit                                        | bootstrap kit                                                                      |
| mission, macro-action, resource, environment     | the same                                                                           |

Page paths follow the interface's words (`/accounts`, `/waiting`, `/activity`, `/reference`,
`/settings`); protocol paths do not move (the MCP door, the git remote, the request URL a refusal
carries, a callback registered at a service).

## 1. Vision

**Let your agent work alone. It stops where you said.** Vaubaan gives a person's agents missions
instead of credentials: first one person on their own computer, then the team they bring, on a
server their company runs, where the agents reach its cloud services without ever holding a
credential, within a declared objective.

The promise and its proof come from the product research of 2026-11-19 and 2026-11-20
([the table](../research/2026-11-19-personas.md), [the façade](../research/2026-11-20-facade.md)),
decided by the owner; who it serves is in [docs/profiles](../profiles/README.md).

**Three pillars**, each shown with its proof wherever the product is presented:

- **It works alone.** The person ticks verbs; Vaubaan writes each permission and its limit.
- **It stops where you said.** What cannot be repaired waits for the person, with the exact call in
  front of them; everything else outside the mission is refused with a reason the agent can read.
- **It never holds your keys.** Credentials stay encrypted in Vaubaan; the agent holds a mission
  key; every call is recorded.

"Then your team" is not a fourth pillar but the second act: the same missions, shared accounts,
one key per person.

**What it replaces.** For one person the first competitor is not another gateway but the agent
client's own "allow once / always": it asks per tool, only while the person watches, and never
reads the arguments. Vaubaan decides on the arguments, counts, and keeps deciding while the person
is away.

**Where the value is born.** In one place: the decision under the tool's name — a merge into a
protected branch is not a push — made by a reviewed risk catalog that turns a call and its arguments
into permissions a human can read. The project's asset is the set of risk catalogs, not the server.
The person feels it at two moments: the silence (an hour of real work, nothing asked, everything
recorded) and the yes (one grave action stopped, shown in clear, decided in seconds). What the
creator buys is autonomy; security is the condition, not the product. The value is paid for by
others: the administrator who installs, the plugin author who models a service, and the security
reviewer who gains nothing and can block everything; a friction on their side costs more than one
on the creator's.

**Moments that decide adoption** (the façade's M1–M7; the site's work toward them is
[website](./website.md) §1):

| #   | Moment                                                   | For whom              | Target                                        |
| --- | -------------------------------------------------------- | --------------------- | --------------------------------------------- |
| M1  | I see it refuse, before installing                       | everyone              | ten seconds on the landing                    |
| M2  | My first governed call, on my own account                | the person alone      | under ten minutes from download               |
| M3  | The silence: an hour of real work, nothing asked         | the mission creator   | day one, right after M2                       |
| M4  | The yes: a merge or a client mail stopped, read, granted | the mission creator   | ten seconds, and the agent resumes on its own |
| M5  | My key, without asking anyone for a token                | the teammate          | one click                                     |
| M6  | They wrote what they do not protect                      | the security reviewer | two clicks from anywhere                      |
| M7  | My plugin runs on a real instance                        | the plugin author     | one afternoon                                 |

The rules that follow:

1. **Credentials stay inside the company**, on its network, behind its identity provider.
2. **A token is issued for an objective, not a person.** A policy says what the agent may risk, how
   many times and how fast; a looping agent stops on its own budget.
3. **Authority narrows with every hand.** The owner has everything and shares less; the beneficiary
   issues narrower missions; nothing is inherited. The chain stops at the mission: no
   machine-to-machine delegation.
4. **The executor cannot enlarge itself.** A refusal is structured, says what to do and points to
   the creator.
5. **An agent may prepare missions; a human remains the creator** and alone answers requests.
6. **Trust in plugins comes from usage**: written against public docs, unit-tested on
   classification, validated by anonymous reports.

### 1.1 Explicitly out of scope

- **No multi-tenancy.** One instance, one company.
- **No identity beyond the instance's own**: no magic link, proprietary SSO or federation, no
  account linking. An invitation is an allow-list entry, not a credential.
- **No high availability.** One process, embedded store; cache, rate limit and counters local to it.
- **No data migration from v4.** A one-shot importer carries what an organization needs, never
  widened, through the interface's checks ([import-from-v4](../handbook/import-from-v4.md)); other
  accounts are reconnected by hand.
- **No CLI or SDK proxy.** Only MCP and the git remote (§4.1 ter) are intercepted
  ([mcp-only-mvp-scope](../decisions/mcp-only-mvp-scope.md)).
- **No general-purpose secret management**, and no cloud resource provisioning by the instance
  itself.
- **No policy composed by the instance from a natural-language task**: that is the client's job;
  macro-actions and their trust levels are the instance-side help.
- **No call held waiting.** The gateway always answers at once; a human steps in outside the call
  (structured refusal, decision in the inbox, replay). No `pending` state, no polling, and no
  notification a mission depends on (§4.2 bis)
  ([unified-gates-drop-confirm](../decisions/unified-gates-drop-confirm.md)).
- **No native mobile application**, and **no notification through a network the instance must
  register at** — a consumer messaging platform with a business account and a fee per message, or
  text messages. The interface installed from the browser is the mobile client (§4.2 bis).
- **No integration tests against real services**, and **no telemetry by default** (§9).

## 2. Domain

### 2.1 Hierarchy

```
Instance                          (one company, one trust domain)
├── Configuration                 (sign-in providers, master key, telemetry, public URL)
├── Users[]
├── Groups[]                      (sign-in provider claims or local table)
├── Accounts[]                 (owner: User | Group; 1 service; encrypted credentials)
│     ├── Resources[]             (ref; environment label)
│     └── Shares[]                (target: User | Group; restriction: RiskId[])
├── Missions[]                    (creator: User; resources per account; (budget, gate) per RiskId; period; expires_at?)
│     ├── Members[], Mission tokens[]  (one per member who generated theirs, plus named tokens)
│     └── Mission log?            (events[]; counters per RiskId) ── Requests[]
└── Audit                         (append-only)
```

### 2.2 Definitions

- A user may own accounts, belong to owner groups, receive shares and create missions; group
  membership is resolved at each sign-in, or kept locally.
- Several accounts may exist for one service.
- A share lets the target accept, in their missions, a subset of its restriction; the owner revokes
  it. There is one active share per account and target: sharing again replaces its restriction. A
  share to a user who owns the account now (owner, or current member of the owner group) is
  refused (`target-is-owner`); a share to a group, or to a former member, is ordinary.
- A mission is the leaf of the authority chain: no parent or child mission.
- A mission token is revealed once when generated, and rotated or revoked on its own.
- A request is open, granted, refused or expired.

### 2.3 States

**Account**: `active` → `expired` (the service rejected the credential and refresh failed) →
`active` once an owner reconnects; `revoked` by an owner, terminal.

- `expired`: every call through it fails `account-unavailable` until reconnected.
- `revoked`: it grounds no authority. Missions carrying it lose that part for good
  (`account-revoked`) and keep serving through their other accounts; one left with none
  becomes `orphaned`
  ([orphaned-missions-and-ownerless-connections](../decisions/orphaned-missions-and-ownerless-connections.md)).
  Nothing takes the lost part's place but an edit or a new mission. Revoking erases the credential
  and, where the service offers it, withdraws the grant there; the interface says whether it was
  withdrawn, must be removed by hand, or failed, and keeps saying it. Local revocation never waits
  on the service.
- `unowned`: its owner group became empty. Missions keep running; nobody can share or reconnect
  until the operator reassigns an owner — the operator's only act on the domain.

A **Vaubaan account** (host account) takes no owner act at all: never shared, transferred or
reassigned, nothing to reconnect; it follows its person (their deactivation stops its missions
through the derived rule, their reactivation brings them back) and is disconnected like any account.

**Share**: `active` → `revoked`, terminal. A mission whose creator then holds nothing on that
account loses its part there, reversibly: it returns when an access covers it again.

**Mission**:

- `active` — headroom on at least one risk.
- `exhausted` — per risk: a risk's quota is at zero for the period; calls touching it are refused
  with the claim URL, others pass.
- `expired` — `expires_at` passed. Terminal unless the creator extends it.
- `orphaned` — none of its accounts serves it (each revoked, or the creator's access withdrawn),
  a share was narrowed under it, or the creator was deactivated. Every call is refused. **Derived
  from the creator's current authority, never stored**: when the authority returns, the mission
  serves again, mission log and counters intact. A share that would bring orphaned missions back names
  them to the owner first (§7.3). An orphaned mission may be closed by its creator or, while
  orphaned, by an owner of one of its accounts.
- `revoked` — by the creator, terminal.

**User**: `active` ⇄ `deactivated` by an administrator. A deactivated user holds nothing from the
next check: sign-in refused, web sessions over, member tokens revoked
(`holder-deactivated`; they stay members), removed from every group (an account left without owner
becomes `unowned`), their missions `orphaned`. Reactivation restores the status only: missions whose
authority still stands serve again; sign-in provider groups return at the next sign-in; local groups,
tokens and reassigned accounts do not.

**Request**: `open` → `granted` | `refused` | `expired` (unanswered after a configured delay). A
granted claim produces an extension or reset event; a granted approval request an approval, consumed
by the first identical call or expired; a granted permission request changes the mission's
permissions and executes nothing.

### 2.4 The cross-cutting invariant — "the executor never sees a service credential"

- The executor authenticates with its mission token, never a service credential.
- The gateway mints or decrypts in memory an ephemeral upstream credential, uses it, releases it.
  The same for git through the git remote (§4.1 ter): the mission token is the password, the gateway
  presents the service's credential upstream, neither crosses.
- **No exception:** no tool hands the agent a service token, short-lived or not (owner decision of
  2026-10-31); work that needs one goes through the gateway, as git does through its remote.
- An exfiltrated mission token grants the mission's rights within its budget until revoked; the
  audit names its holder, and revoking it leaves other holders working.
- An exfiltrated key of a mission holding a Vaubaan account issues missions within the creator's
  authority and that mission's accepted risks and budget, until revoked; every mission so issued is
  visible to the creator and marked as prepared by that mission, and none carries a Vaubaan account.

## 3. Authority — composing restrictions

### 3.1 The chain

```
Account owner              authority = the service's full risk catalog
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

- **Monotonicity.** Each stage is a subset of the one above; exceeding it is refused at issuance
  with the explicit list of uncovered `RiskId`s.
- **Enumeration.** No stage says "everything". "Select all" and `everything-i-hold` record the list
  resolved at the click or at issuance; a risk added to the risk catalog, or a widened authority, later
  does not widen the mission.
- **Union of shares.** Several shares on one account (direct and through groups) give the union
  of the restrictions.
- **The owner needs no share** to issue missions on their account.
- **Several accounts of one service in a mission**, each checked against the creator's authority
  there, each with its own resources, sets and budget. A call runs with **the account holding the
  resource it names**, or the account the agent names (`vaubaan_account`, §4.1); a call that names
  neither while two accounts of its service could serve it is refused `account-ambiguous` (§4.1),
  never sent to one of them by default; so is a call naming resources of two of them.
- **Resource sets.** Within one account, a mission can give different resources different
  policies and budgets. Each resource belongs to one set. A call that cannot be placed in one set is
  judged by the strictest of its candidate sets (risk model §4.7).
- **Resource selection.** A mission names, per account and per set, the resources it may touch:
  an explicit list, all of one environment (a label, or none). A call citing a resource outside it is refused
  `resource-not-in-mission` before any risk is evaluated. **What a mission creates, it reaches**: a
  resource it creates through the gateway with a declared creating tool joins its selection right
  after that call, marked "created by this mission" and audited
  ([created-resources-join-the-mission](../decisions/created-resources-join-the-mission.md)). One
  first seen less than 15 minutes ago is not dropped by a discovery that does not list it yet. Any
  other later resource is not covered until the creator edits the mission — unless the set has
  **future resources** on, chosen explicitly and never a default: then a resource that later
  appears with the set's environment (discovered, or relabelled into it), neither hidden nor the
  instance's own nor held by another set of the mission, is written into the set's list and audited
  on the mission. A resource relabelled out of a set's environment leaves the set; it joins the set
  of its new environment with future on, else it leaves the mission
  ([resource-set-is-one-environment-with-optional-future-resources](../decisions/resource-set-is-one-environment-with-optional-future-resources.md)).
  An unlabelled resource enters a set only on a service whose risk catalog has no env-qualified risk.
  Environment-qualified risks are checked at issuance against the resources known then.
- **The instance's own resources** — what hosts or runs the instance (where the plugin can tell, or
  as the operator lists in the configuration) — are never mission resources: not offered, a draft
  selecting one refused, a call citing one refused `resource-not-in-mission`, and the account page
  says why; on an account that hosts the instance, a tool that cannot be bound to one resource is
  refused
  ([self-resources-never-reachable-by-a-mission](../decisions/self-resources-never-reachable-by-a-mission.md)).

### 3.2 The budget

A policy is complete only with budget and gate for every accepted risk: the gateway refuses to issue
a mission whose accepted risk has no resolved budget.

- **Unit.** One action = one allowed call touching the `RiskId`. A call touching N risks decrements
  N counters; a refused call decrements nothing.
- **Quota.** Actions per period, always a number: no infinite budget. At zero the risk is
  `exhausted` until the next period or a granted claim.
- **Rate limit.** The mission-level value of the risk catalog's speed cap
  ([gateway-risk-model](./gateway-risk-model.md) §4bis), bounded by the risk catalog.
- **Macro-actions and trust levels**
  ([macro-actions-and-trust-levels-prefill-the-policy](../decisions/macro-actions-and-trust-levels-prefill-the-policy.md)).
  At issuance the creator ticks macro-actions per account, each at a trust level (or duplicates a
  mission); the policy is pre-filled with their risks, gates and budgets, intersected with the
  creator's authority, then adjusted risk by risk. The persisted policy never references a
  macro-action or a trust level, so a changed risk catalog alters no mission; the trust levels are recorded with the
  mission only to redraw the form. The interface shows what each macro-action yields at its trust level
  (how many run freely, ask first, are left out) and the account's highest row.
- **`everything-i-hold`**
  ([preset-everything-i-hold-expands-explicitly](../decisions/preset-everything-i-hold-expands-explicitly.md)).
  At preview and issuance it expands to one line per non-deprecated `RiskId` the creator's authority
  covers now and the selected resources can reach (an environment-qualified id only when a selected
  resource carries that label, own or default, or the plugin derives the environment), the fallback
  included and named. Each line gets the risk catalog's rate ceiling (else its base budget's rate at
  Autonomous, else a value by row), its base budget's quota at Autonomous (else by row) sized
  for a daily period, and gate `auto`. The preview states the line count, the hardest to repair,
  which lines that cannot be repaired (row 4) run freely, and the fallback; no gate is added silently.
- **Editing a mission**
  ([mission-editable-after-issuance](../decisions/mission-editable-after-issuance.md)). The creator
  may edit a mission while it is not revoked or orphaned — never an agent: name, expiry,
  accounts, per account the resources, permissions, and per permission its quota, rate limit
  and gate. **Never its period**: a mission needing another is duplicated. The gates of an expired
  mission stay editable. An edit is judged by issuance's own check applied to what it moves, with
  the words a creation asking the same would get; a fact unrelated to the change does not refuse
  narrowing. It applies at once to the same tokens, mission log and counters: consumed stays consumed
  (even when a removed permission is added again), a quota lowered below it leaves the risk
  `exhausted` until the next period, an added permission starts at zero, a removed one is refused
  from the next decision; a call reads the limits and gates in force when it is decided. Setting
  `approval` on a gate opened for the period ends the opening. Requests a removal makes moot are
  closed with that reason. An edit started from a mission that changed meanwhile is refused. Every
  edit is one administrative act carrying before and after per section moved.
- **One budget per mission**, however many agents or tokens. Distinct budgets mean two missions.

### 3.3 The mission log and the remaining budget

- Born on the first call with the mission's token.
- Holds, per `RiskId` and period, the actions consumed; the remainder is computed without re-reading
  the audit.
- Period rollover is computed on read, never by a background task.
- The mission log is the truth for the budget, the audit for what happened; they must agree (§10).

### 3.3 bis Editing permissions and asking for a missing permission

- The creator adds and removes permissions by editing the mission (§3.2); additions need explicit
  limits and a gate, validated against the creator's current authority.
- A missing-permission refusal opens no request. The agent may request its missing permissions,
  citing that refusal's reference (valid 15 minutes, bound to the authenticated mission and token)
  and saying why the task needs them
  ([permission-request-asked-by-the-agent](../decisions/permission-request-asked-by-the-agent.md)).
  The request holds the observed tool and missing permissions; the justification is marked as the
  agent's text.
- Only the creator answers: add the permissions with explicit budgets and gates, or refuse. An
  answer never executes the call; the agent retries.
- An open request with the same mission, holder and missing permissions is reused; a used reference
  returns its existing request, even after a decision. At most ten new permission requests per
  mission per rolling 24 hours.

### 3.4 Requests to the creator — the claim

Claims and approval requests are automatic: the gateway refuses the call, drops a request in the
creator's inbox and puts its URL in the refusal. The executor or its human forwards the URL.

- The request page requires a sign-in and checks the user is **the mission creator**; anyone else is
  refused, a beneficiary of the same share or a member included.
- The creator sees the mission log, the risk, the other risks' remainders, and chooses: reset
  the period, extend the quota, extend the expiry, or refuse. **A claim is about one risk, and so is
  its answer**: reset zeroes that risk's counter for the current period; extend gives back at most
  what the period consumed on it. A larger quota, or room on another risk, is an edit (§3.2).
- The claim produces an event; the token does not change; the executor replays. A refused or expired
  claim leaves the risk `exhausted` until the next period.

### 3.5 Requests to the creator — the approval

- A call touching a risk gated `approval` is refused `approval-required` with the URL of an approval
  request; nothing executes, nothing is held. A call touching several risks, one gated, is refused
  as a whole; several gated risks make **one request** listing them all
  ([one-approval-request-covers-the-call](../decisions/one-approval-request-covers-the-call.md)).
- The request shows the tool, the **arguments in clear**, the slices touched, the remaining budget —
  an argument the plugin declares secret is shown as a short fingerprint
  ([secret-arguments-masked-in-the-approval-view](../decisions/secret-arguments-masked-in-the-approval-view.md)).
  Arguments are kept encrypted for the request's lifetime, then erased; only their fingerprint stays
  in the audit.
- A grant produces an approval bound to `(mission, tool, argument fingerprint)`, covering only the
  gated risks the request listed, single-use, valid a short configured time from the grant. The
  executor replays **identically**; arguments different by one byte ask again.
- The creator may instead **open the gate for the rest of the period**: the risk is `auto` until the
  next reload (a mission log event).
- The gate does not replace the budget: an approved action counts against quota and rate limit.
- All requests share the inbox, sign-in, states and expiry delay; an unanswered approval request
  expires like a claim, its arguments erased then. A request on an orphaned mission cannot be
  granted and expires on the same delay.

Every refusal calling for more authority goes to a human: `budget-exhausted` through a claim,
`approval-required` through an approval request, `risk-not-accepted` through a permission request or
an edit.

## 4. Format / Layout

### 4.1 Execution surface

The execution MCP endpoint (`Authorization: Bearer <mission token>`) and, for a service whose
agents speak git, the git remote of §4.1 ter: same token, admission, decision and audit.

- **Discovery** (`tools/list`): the tools of the mission's services, a lost account's excepted,
  listed once per service whatever the number of its accounts in the mission (with several, each
  tool takes one more optional argument, `vaubaan_account`, listing them),
  filtered per service, not per tool: a listed tool may still be refused `risk-not-accepted`
  (§11.2).
- **Call** (`tools/call`): the account that serves it (the one the agent names with
  `vaubaan_account`, by id or name, taken out of the arguments before any stage, so no plugin sees
  it; else the one holding the resource the call names; else the only one of its service). A call
  that names an account and a resource of another is refused. Then classification by the plugin, intersection with
  the risk catalog, `risks_touched ⊆ accepted_risks`, budget check, upstream credential mint, forward, audit.
  Arguments that are not JSON values (a non-finite number…) are refused before any stage, audited,
  no budget spent. The audit copy of a structural refusal reason replaces argument values with
  `[argument]`.
- **Structured refusals**, each with an agent-readable `hint`:
  - `risk-not-accepted`: missing risks, slices executed, and a short-lived refusal reference for a
    permission request (§3.3 bis).
  - `budget-exhausted`: `RiskId`, quota for the period, consumed, end of period, **claim URL**.
  - `approval-required`: every gated `RiskId` the call touches, argument fingerprint, **approval
    request URL**, validity delay, and the instruction to replay identically once approved.
  - `resource-not-in-mission`: the ref cited, the account, the resources the mission may touch
    (of every account of that service).
  - `account-ambiguous`: several accounts of the call's service could serve it, because the call
    names no resource or names resources of two of them (risk model §4.7): the service, each
    candidate account (id, name) with its resources; the hint says to name a resource, or the
    account with `vaubaan_account`, which a tool that can name no resource (a list, a search, a
    creation) needs.
  - `rate-limited`: `RiskId`, limit, delay before retry.
  - `account-unavailable`: the account is `expired`; its name and the owner to contact.
  - `account-revoked`: the account no longer serves this mission: account id and name,
    cause (`account-revoked` by its owner, `access-withdrawn` from the creator) and whether
    final; the hint says to keep using the other accounts and ask the creator for the replacing one.
    Git on that account is refused the same way.
  - `mission-inactive`: `expired`, `orphaned` or `revoked`, with the reason.
  - `wrong-credential-kind`: the bearer is not a mission token, naming the door that would accept
    it.
- **A token that stopped working** is not a structured refusal: `401`, with a reason stated only to
  a caller whose secret was recognised (an unknown bearer gets a bare `401`): `token-rotated`,
  `token-revoked`, `holder-removed`, `holder-deactivated`. It consumes nothing and leaves no call
  entry.
- **Catalog**: a read endpoint, by mission token: the full tool surface, what the mission may call,
  the refs and environment labels of its resources, the remaining budget per `RiskId`. The agent's
  only discovery of upstream refs.
- **Streaming**: a call is always answered by one complete result. A plugin may emit parts of a long
  upstream response as progress notifications to a caller that asked. Decision and decrement are
  complete before the first part leaves; a broken stream is an allowed call with an upstream error,
  its credit consumed.

### 4.1 bis Management surface: the `vaubaan` plugin

The gateway's own management tools are a plugin, `vaubaan`, called on the execution door
like any service's: a risk catalog, macro-actions, a data model and a Reference page
([platform-management-is-a-plugin-on-the-execution-door](../decisions/platform-management-is-a-plugin-on-the-execution-door.md)).
A user connects their **Vaubaan account** in one click (a host account: no secret, theirs alone,
never shared), issues a mission on it — the interface offers the **platform management mission**,
every macro-action at Careful, in the creation form — and hands its key to an agent, which calls the
`vaubaan__*` tools with it. The call passes the door, the budget, the gates and the audit like any
other; the tools then act **in the name of the mission's creator**, within their current authority.

- **Read** (`vaubaan__list_my_accounts`, `vaubaan__get_catalog`, `vaubaan__list_my_missions`): my
  accounts and those shared with me, with the exact restriction; each service's risk catalog with its
  macro-actions, each risk's row and its reason, and the trust level table; my missions, policy,
  mission log, remaining budget and who prepared each.
- **Preview** (`vaubaan__preview_policy`) a draft `RiskId → (budget, gate)` on some accounts:
  what passes, what exceeds the authority, what the mission could call; issues nothing. A draft
  account may give trust levels per macro-action, which write its policy when it gives none and
  the missing budgets when it does, or name `everything-i-hold`; the preview answers with the
  explicit lines.
- **Issue** (`vaubaan__issue_mission`) a mission. The creator is the calling mission's creator,
  never the agent; the new mission names the calling one as the mission that prepared it. The answer
  holds the token, revealed once, and the bootstrap kit.
- **Rename** (`vaubaan__rename_mission`) or **edit** (`vaubaan__edit_mission`) any of the creator's
  missions, as their own "Edit mission" does: one version in the History, by the calling mission,
  within the creator's authority now and refused whole beyond it; `vaubaan__preview_policy` with a
  `mission_id` previews the edit.
- **Plugins** (`vaubaan__upload_plugin`, `vaubaan__plugin_status`), only when the creator is an
  administrator of the instance: upload a plugin archive, which stays inert until an administrator
  activates it in the interface (§4.2, Administration › Plugins); read each plugin's versions,
  signer, pending activation and the updates available.
- **Rotate** (`vaubaan__rotate_mission_token`) the token of a mission the calling mission issued
  (another is refused `mission-not-issued-here`); **revoke** (`vaubaan__revoke_mission`) any of the
  creator's missions.
- **The self rule**, checked by the host at every call whatever the stored selection says: a mission
  issued or edited here never carries a Vaubaan account (`vaubaan-account-not-allowed`); the calling
  mission never renames, edits, rotates nor revokes itself (`self-not-allowed`); only the creator's own key or a machine key
  calls these tools — a teammate's key is refused (`teammate-key-not-allowed`).
- **Never exposed**: answering a request; opening a gate, extending a budget or changing a mission's
  limits or permissions other than by a whole edit judged as above; resetting a period; connecting, sharing, transferring or revoking an
  account; executing another service's tool; adding members or making named tokens; activating,
  rolling back or removing a plugin, or changing the trusted signers.
- The plugin's `execute` is composed by the host from the mission service, never through the SDK;
  a plugin declaring a host account is compiled into the server, never loaded from an archive. The host's
  own tool `vaubaan__request_permission` is answered by exact name before the registry, which refuses
  a plugin tool of the same name.
- The retired management door, `/mcp/manage`, answers 404 with a hint to this plugin.

### 4.1 ter Git remote — the second door of the execution surface

For a service whose plugin declares it, the instance is the agent's git remote:
`https://<instance>/git/<service>/<owner>/<repo>.git`, the path naming the service by its plugin
id; any number of plugins may declare one
([gateway-as-git-remote](../decisions/gateway-as-git-remote.md),
[protocol-doors-belong-to-the-host](../decisions/protocol-doors-belong-to-the-host.md)). A
`<service>` that is not a plugin declaring a git remote is answered not found; a mission without an
account on it is refused. The path names the repository, hence the account: with several accounts
of one service, each repository has its own URL and the same mission token reaches all of them.

- **Authentication**: the mission token is the HTTP password, read by a credential helper from the
  kit's variable (§4.4), never in a URL or file. Admission is the execution door's own: same
  verifier, `401` reasons, `wrong-credential-kind`, per-mission rate limit, one window for both
  doors.
- **Fetch and clone** are relayed as a stream, never stored. The object transfer is one call (risk
  `read-code` for GitHub), counted and audited; listing refs is checked, not counted.
- **Push** is decided ref by ref, every ref of it (branches and tags only): creation, fast-forward,
  rewrite, deletion, tags and CI workflow changes each map to risk catalog permissions. The whole push is
  **one call**: one decision, one request when gated, one audit entry; one refused ref refuses the
  push. Claimed ref values are checked against the service. What a push brings is what no service
  branch already holds, and every commit is reviewed, not only the net change. **A refused push is
  refused before its content leaves for the service**; a rewrite or deletion moves only if the ref
  still holds the reviewed value.
- Temporary refs used for the review carry no mission identifier, are hidden from relayed listings
  and are deleted on every path; those of a push awaiting approval stay until the request expires. A
  mission holds a bounded number of them and runs a bounded number of pushes at once.
- **Refusals** reach git as words git prints: the reason on the rejected ref, what to do on
  `remote:` lines, the request URL whole. An approved push is replayed by pushing the same commits;
  a changed commit asks again.
- **Fail closed**: an unimplemented capability (atomic pushes, push options, signed pushes), a
  malformed or oversized request, too many refs, a pack above the configured cap, a push the
  service cannot compare in full: refused with a sentence, audited. Git LFS is not served. A
  mission that may not push is not offered push.
- The git tools are not MCP tools: calling them over MCP is a structural rejection, and the git door
  reaches no other tool.

### 4.2 Human surface

A web interface served by the instance, behind sign-in, in the interface's words (§0). Seven entries
— Now, Waiting for you, Missions, Accounts, Activity, Reference, Settings. A page offers an act only
when the instance would take it, and the instance checks again on arrival. **A confirmation is
asked only before an act that deletes, stops or hands over something for good** (replacing a key,
removing an access, disconnecting an account or an app, deactivating a person, removing what was
set up, finishing the setup), and before an access that would bring stopped missions back to work
(§7.3: their agents act again at once); the hardest of them (stopping a mission, removing a teammate, leaving, revoking a key)
are confirmed by typing a name. Creating, editing and anything that can be switched back act at
once, with a busy button and the outcome on the page that follows; a refusal shows where it
applies. **The instance's name** (§4.3) is shown
above the navigation, in every page title and on the sign-in page, as text; the public URL's host
stands in without one. An (i) beside each page title shows that page's context — what it is
for, in a few sentences — with a link to its documentation under the documentation base (§4.3);
the (i) itself never leaves the page.

- **Now** — the home. _Something waits_: my requests first, then running missions one line each,
  then counts leading elsewhere. _Nothing waits_: one sentence and how many missions run. _First
  run_: what the product is, the steps (an account, a first mission, the kit); an administrator
  first reads what is left to set up. **A yes is never given from the home**: an approval leads to
  its page; a refusal may be given from the row.
- **Waiting for you** — the inbox of requests awaiting me as creator. Each request has its own page
  at the URL the executor hands over: who asks on which mission, the call (tool and, for an
  approval, the arguments in clear, secret values as a fingerprint), the permission and its
  row, the room left, what each answer does. **A yes is given on this page only.** Its
  statement is the risk catalog's label of the risks plus the tool and arguments by name, never a sentence
  composed from arguments. Answers are the protocol's (§3.4, §3.5); a limit changes for good only on
  the mission. A closed request shows its outcome; anyone but the creator reads one sentence and
  nothing of it.
- **Missions** — mine and those I am a teammate of; a row says when it waits for my answer and names
  the mission whose agent prepared it ("prepared by mission X for you"); stopped missions are behind
  a filter. **Creating**, on one
  screen: a name (or a copy of a mission, or a pasted agent proposal), the period and the end, and
  one **card** per resource set. "Add an account" picks an account, then its resources grouped by
  environment (one environment per card), plus "future" ones — nothing ticked by itself unless
  the group holds one resource ("Select all" otherwise), the hidden ones collapsed and never
  ticked; only the cards of the mission are shown. A card lists the account's macro-actions, each ticked at a trust level — Careful, Trusting,
  Autonomous, or Custom when its lines were edited by hand ([risk model](gateway-risk-model.md)
  §4.6); Custom opens the macro-action's permissions one by one (behaviour and limits, filterable by
  plane), and hovering the line shows the same content read-only. The trust levels are sent only to
  redraw the screen. **Creating asks nothing**: what is sent is the explicit list (every permission
  by account, with limits and gate), checked again on arrival — a refusal shows beside the cards —;
  then the key, shown once, with the setup kit. The mission page shows the explicit list read-only. **On a mission**, in this order: its state and a
  waiting request (the way to answer for the creator; whose answer it waits for, for a teammate);
  its **Keys** — who holds one, what each key did this period — before the permissions, since
  it is short and they are long; then the creation screen, read-only, with one more column:
  today's use per macro-action (the permission closest to its limit), each permission's use on
  hover; then its activity and History. Every act on a key lives in Keys: **Add keys**, for the
  creator, one dialog choosing a teammate (a person who signed in; they generate their own key)
  or a machine key (named, shown once); generate, replace and revoke on the rows. The "···" menu
  keeps the acts on the mission itself (activity, duplicate, leave, stop), drawn as a button
  like its neighbours. **Edit mission** opens the creation screen prefilled (period fixed); its bar says what
  changed, and saving applies at once, back on the mission page that says it was saved.
  **History**: the versions of its configuration, newest first — number, author (a person, a
  mission through its Vaubaan account, or the gateway for a resource the mission created or one
  that joined on its own), date, cause (created, edited, permission request accepted, resource
  created, resources joined or left, end moved by an answered request, restored from version N)
  and what moved; expanding a version shows what differs from the previous one. Every change of
  the configuration (name, end, accounts, resource sets and their resources, permissions with
  their limits and gate) writes one version; a write that moves nothing writes none. Keys,
  teammates and what was used are not part of a version, and the section says so. **Restore this
  version**, on a past version, for the creator: no confirmation (restoring again undoes it),
  judged as an edit under the creator's authority now — a permission they no longer hold, an
  account they lost and a resource that no longer exists are left out and said; an end already
  past keeps the current one. It writes a new version ("restored from version N"), never
  rewrites history, keeps the key, the mission log and the counters, and says "Restored".
  **Replace key**: the old key stops at once, no grace period; a machine key is replaced in one act.
  A teammate never sees a pending approval's arguments nor their fingerprint, and their home does
  not list the creator's requests.
- **The activity of a mission** — its mission log: what waits, who called this period per key holder and
  per agent label (self-declared, and the page says so), what each permission used, earlier
  periods' counters. Its events are the Activity's Timeline filtered on the mission, its audit the
  Record filtered on it; both are linked from it and from the mission.
- **Accounts** — mine (alone or through an owning team) with their state; "Shared with you" with the
  exact permissions of each access; the services I can connect. **On an account**, for its owners
  only: who has access and up to what; its resources and environment labels; every mission that
  carries it, whoever created it — name, creator, state and who holds it, only this account's part,
  nothing of the mission's other accounts; removing an access or disconnecting says how many
  missions stop. Its resources and its key's rights read "Updated 12 min ago" and refresh themselves
  (§0 Resource): a stale account is shown at once with what is known, marked "Refreshing…", then
  updated in place. **"Give access"**: a person or team, then the permission checklist with "select
  all", each with its row and reason; it lists the orphaned missions the access would bring back.
  Ownerless accounts are the last region for an administrator, who names a new owner there.
  **The Vaubaan service** is among the services: "Connect" is one click, no field; its account page
  names the missions that use it, offers no "Give access", and offers **Create the platform
  management mission** — the creation form prefilled with that account, every macro-action at
  Careful, the form's default period and end, which the person may change before creating it.
- **Reference** — for every registered plugin, read-only, for any signed-in user: **the
  plugin's page, exactly the one the public site shows** at `/plugins/<id>` (website spec §2.3,
  sections 1–8: the header, the model, the macro-actions, the map, a few calls, Anything else, the
  tools, the retired permissions, connecting an account), one implementation shared by both, drawn
  for the plugin version this instance runs — bundled or pinned, so a pinned older plugin shows
  its own risk catalog — in the interface's tokens and themes. The site's own parts (health from the
  collector, links, crumbs) are left out; its links to the docs go under `docs.url`. Above the
  page, never inside it, a strip says what only the instance knows: the plugin version it runs and,
  when the operator pinned it rather than the image bundling it, that it is pinned and which
  bundled version it replaces; the community validation of that version; the instance's git
  remote for the service. Every permission (`#risk-<id>`) and macro-action (`#macro-<id>`) has an
  anchor, and every permission shown elsewhere links there. The list of services shows each with
  its mark and its plugin's one-line description.
- **Activity** — three tabs. **Overview**, its home (`/activity`): one block per mission the reader
  reads on the Timeline, over today, 7 or 30 days — calls allowed and refused, requests waiting,
  bytes sent to the services and received from them (counted on every forwarded call, MCP and git;
  older calls carry none); behind each block, the requests per account, the use of each action
  against its limit in the mission's current period (the permission closest to its limit), and the
  key holders with their share of the calls; above them, what stops working within 7 days — a
  mission's end, an account's pasted key ending, an account its service refused — each linked to
  where it is fixed. Every number opens the Record or the Timeline filtered on it. **Record**: the audit, filtered by period, mission, account, tool,
  decision, person, key holder, agent label and kind; each line has a detail at its own address;
  who reads what: §8. **Timeline**: the mission log events (calls, requests and their answers, resets,
  limits, gates, keys) of the missions I created or am a teammate of — of every mission for an
  administrator; an account's owner reads its calls in the Record, not the mission logs of the missions
  that carry it —, filtered by mission, key holder and agent label. Both list newest first, in pages
  of 50 reached by Newer and Older, the page in the address; a filter applies as soon as it is
  chosen.
- **Settings** — for everyone: theme; the second factor (enrol, replace, remove after a fresh
  sign-in — never an administrator's); a sign-in account's password; **Notifications** (my devices, messaging
  addresses and mail, §4.2 bis). For an administrator, **Administration**:
  - a setup checklist of what the instance still needs, with no step per service;
  - **sign-in providers**: kind, admission rule, the callback to register, whether on, and, after a
    restore on another address, that it was set up for the former one. An administrator adds, edits,
    tests, switches on/off and removes one, its secret never shown back; one set by the
    configuration file is read-only and always on; sign-in accounts are added in one step. A
    sign-in provider added here is **off until a test passed**: the test runs its sign-in in another
    window, signs nobody in and writes no user, session or group, then shows what it returned and the verdict a
    sign-in would get; during setup the setup link's holder may make the tested identity the first
    administrator. Editing a sign-in provider that is on marks its test stale. Switching one off or removing
    it ends its users' web sessions (never the administrator's own) and is refused when it is the last
    way in of every administrator;
  - **people**: deactivate, reactivate, make or unmake administrator; the administrators and who
    named them; when the configuration's rule differs from the applied one, the page offers to apply
    it; **invitations** (with sign-in accounts, inviting sends the account-creation link or shows it
    to copy, and the page can resend it, send a password reset and reset a second factor, each
    audited). Removing an invitation stops the next sign-ins, not an open session;
  - **OAuth brokers**: where an account of a service with no key to paste signs in
    ([ADR](../decisions/oauth-brokers-managed-in-settings-with-two-client-sources.md)). The page
    lists the services shipped plugins sign in through a broker, each with the one source that
    serves it, whether attested, and its plugins; a service no source serves is marked and the page
    offers to add one. A source is an **external broker** (URL, enrolment key, attestation required
    or none, the services it serves; the key is provided by the broker) or **this gateway's own client** at one service (client id and
    secret the administrator created there, the redirect to register shown to copy). An
    administrator adds, tests, edits and removes a source, its secret never shown back; one set by
    the configuration is read-only and always on; one added here is off until a test passed, which
    runs a sign-in in another window and connects nobody. Changing the source of a service leaves
    the accounts connected through the former one working and is confirmed with that consequence;
    a changed public URL marks an own client as to re-register at the service;
  - **plugins**: every plugin the instance knows, with its active version, its **signer**
    (signed by Vaubaan; signed by a signer this instance trusts, named; unsigned, allowed by the
    configuration — a modified or invalid archive never gets this far), where it comes from
    (installed here, compiled into the server for the management plugin and `ssh`, or pinned by
    the operator in the plugins directory), the versions kept, whether
    the configuration enables it, how many accounts it serves, and its community validation. From
    the published versions feed the page says what is behind, what an advisory names with the
    version that fixes it, and offers to install a catalog version in one click.
    A plugin the instance does not have yet is installed **when a person first connects its
    service**: the gateway takes the catalog's latest version, keeps it only signed by Vaubaan, and
    loads it at once; any signed-in person may, and the installation is audited
    ([ADR](../decisions/plugins-installed-when-first-needed.md)). Every other version — a newer
    version of a loaded plugin, a private or unsigned one — an administrator **uploads** or
    **installs** from the catalog; it stays **pending**, inert, until an administrator
    **activates** it, shown its signer and digest,
    what it replaces, the permissions it adds or deprecates against the active version, the
    missions using the service and the permissions none of them holds — and for an older version,
    the accounts connected a way it does not offer and the permissions it does not know, which stay
    stored and inert. Activating is confirmed by typing the plugin's id and takes effect at the
    next start, which the page can trigger. The version starts **on trial**: it becomes active
    once loaded and its own examples classified; otherwise the previous version is restored and the
    failure shown here. An administrator also **rolls back** a plugin to the version it ran last, from its row, sets a plugin to
    **follow the image** again, **removes** an installed plugin no account uses, opts a plugin into
    **automatic security patches** (Vaubaan-signed patch versions that fix an advisory, started on
    trial, every administrator notified), and manages the **trusted signers** (adding one is
    confirmed by typing its name and notifies every administrator). The instance keeps, per plugin,
    the active version and the two previous ones. An id the catalog uses is activated only signed
    by Vaubaan
    ([ADR](../decisions/plugins-activated-by-an-administrator-on-trial.md));
  - teams (local ones); telemetry; the instance's name. Other
    §4.3 keys are shown, not edited; the name and the telemetry opt-in are set here unless the
    configuration sets them (then read-only). Every interface change is audited.

Styling follows [style-guide](./style-guide.md).

### 4.2 bis Notifications

The interface is installable from the browser on a phone or a computer; installed, it is the mobile
client and receives notifications while closed. Notifications are optional and belong to the
person: nothing in a mission depends on one
([notifications-reach-the-persons-own-channels](../decisions/notifications-reach-the-persons-own-channels.md)).

- **What notifies**, each to the one person concerned, at once when the event happens, once.
  _Something waits for you_: a request opened in my inbox as creator (claim, approval request,
  permission request). _Something stopped without you_: an account of mine that needs reconnecting
  (credential rejected or expired), a mission of mine orphaned, or revoked by someone else; for an
  administrator, a failed backup and a master-key recovery. Nothing is batched, nothing repeated.
- **What a notification says.** The instance's name, the kind, the mission's or account's name and,
  for a request, the tool by name; nothing else. Never an argument, a fingerprint, a secret value, a
  resource name or a person's name. Opening it leads to the request page, the mission or the
  account. **No answer is given from a notification**, not even a refusal.
- **Channels are the person's.** In Settings, a person sees their devices and messaging addresses,
  names them and removes any; a device is subscribed only by the person's act on that device, and
  the interface proposes it the first time something waits. A messaging address is a secret of the
  person, sealed, never shown back, checked on entry by a test notification. Mail is a channel when
  the instance delivers mail (§4.3), switched on by the person. An administrator sees how many
  channels a person has, never which.
- **Delivery is best effort.** The instance posts to a channel and moves on: a failure is logged,
  never retried in a loop, never visible to the executor. A device whose push service refuses it
  for good is dropped and the person's Settings say so. The home and the inbox stay the reference: a
  person without a channel misses nothing but the alert.
- **Live when open.** The home and the inbox refresh themselves while the interface is open; that
  is not a notification and needs no channel.

### 4.3 Instance configuration

The operator provides, through environment variables or a mounted file (the file wins), never
committed:

- the **master key** for encryption at rest — provided, or generated at first start on request, then
  handed to the administrator by the setup, who confirms keeping a copy before anything else; never
  generated over a store that holds data
  ([master-key-generated-and-handed-over-by-the-instance](../decisions/master-key-generated-and-handed-over-by-the-instance.md)).
  An administrator can download it again after a fresh sign-in, audited;
- the **public URL** (sign-in and service callbacks, request URLs, the kit), HTTPS, except an
  instance in **local mode**, meant for the computer it runs on, whose public URL may be `http` on a
  loopback host only ([ADR](../decisions/local-mode-for-an-instance-on-this-computer.md));
- the **sign-in providers**: zero or more, each with id, name, kind, issuer, client id and secret,
  claim mapping for OpenID Connect, allowed email domains and whether invited-only. An open
  sign-in provider with neither allowed domains nor invited-only is refused at startup and in the interface;
- optionally, **mail delivery** for account-creation and password reset links and for mail
  notifications (§4.2 bis); without it the links are shown to the administrator to hand over;
- **nothing per channel**: the key pair that signs device notifications is generated at first start
  and sealed under the master key; a messaging address belongs to a person (§4.2 bis);
- **nothing per service**: people connect with a key they make at the service; a service that
  connects only through its own sign-in gets an OAuth client the gateway registers itself (dynamic
  client registration) the first time someone connects, one per instance, secret sealed, registered
  again when rejected or when the public URL changed
  ([oauth-client-registered-by-the-gateway](../decisions/oauth-client-registered-by-the-gateway.md));
  a service that offers neither signs in through a **broker** managed in Settings (§4.2), an
  external one or the gateway's own client at the OAuth provider
  ([ADR](../decisions/oauth-brokers-managed-in-settings-with-two-client-sources.md)); optionally,
  **external brokers** (`oauth_brokers.<name>`: URL, enrolment key, attestation, broker providers) as
  read-only seeds of that page;
- the **bootstrap token**, the setup link's secret, required while no sign-in provider is
  configured; an instance whose store names no administrator, with neither a token nor an admin
  rule, refuses to start — in local mode, made by the instance at each start when not
  given, its setup link printed on the instance's own output until the setup is finished;
- optionally, the **admin rule**: a group of a named sign-in provider and/or a list of emails — a
  seed, applied once at the start where the store names no administrator, never again by itself
  ([administrators-live-in-the-instance](../decisions/administrators-live-in-the-instance.md)). A
  group matches only the members its sign-in provider claims; a group without a sign-in provider is
  refused with several sign-in providers configured;
- optionally, a **scheduled backup** to object storage (frequency, how many to keep); without it the
  instance backs nothing up (§6);
- the **telemetry level** (§9) and the collector URL;
- optionally, the **plugins directory** (`plugins.dir`, the image's `/plugins`) where the
  operator pins plugins, one directory each; **`plugins.enabled`**, the ids the instance
  registers (unset: every plugin it has); **`plugins.allow_unsigned`**, the ids the instance may
  activate without a signature — the only way an unsigned plugin runs, which no interface sets;
  and **`plugins.safe_mode`**, a start ignoring what was installed here (the management plugin,
  `ssh` and the operator's pins only), the way back when the interface cannot be reached. A pinned
  plugin replaces an installed one of the same id. A pinned plugin built for another SDK range, a duplicate, or a service the store holds
  accounts for and no registered plugin serves, stops the start with a message naming it
  ([ADR](../decisions/plugins-bundled-or-pinned-by-the-operator.md));
- the **versions check** (`updates.check`, on by default; `updates.feed_url`): at start and daily,
  the instance reads the published versions feed — a request carrying nothing about the instance —
  and compares locally; the result is shown in Administration › Plugins; nothing is downloaded but
  the catalog archive an administrator chooses to install;
- the **documentation base** (`docs.url`, default `https://vaubaan.com/docs`): where the
  documentation link inside the (i) of every page header points;
- optionally, the instance's **name**: 1 to 64 characters, no control characters, a label never
  markup.
- optionally, **ceilings** on users, connected accounts and active missions, and the **counters
  token** that opens the counters (§4.3 bis).

Optional keys have defaults, among them the audit retention (ninety days), the request expiry (twenty-four hours) and the approval validity (ten minutes),
the git remote's largest push and longest request, and how often the accounts refresh themselves
(`accounts.refresh_interval`, one hour; `0` turns the automatic refresh off, hourly and on open). Anything missing makes startup fail with a
message naming it.

### 4.3 bis Ceilings and counters

An operator may cap how much an instance holds: `limits.users`, `limits.accounts` and
`limits.active_missions`, each a positive whole number. A ceiling that is absent is unlimited, and
that is the default. The same counts serve the ceilings, the administrator's view and the counters
endpoint, so the three never disagree:

| Count           | What it counts                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| users           | people not removed, whether or not they have signed in yet; never an agent or a mission token                |
| accounts        | connected accounts not revoked, every owner together; an expired or ownerless one still counts until revoked |
| active missions | missions neither revoked nor past their end, orphaned ones included                                          |

- **Enforced where an item would be added, never by cutting.**
  - A person is refused when they would become a new user: a first sign-in of any kind, an
    invitation sent or accepted, an administrator named who is not yet a user, a removed user
    reactivated.
  - An account is refused when a new one would be created: by any connect flow, before the
    service is reached where the flow allows it, and again when the account is stored. Reconnecting
    an existing account is never refused.
  - A mission is refused when issuing it would add an active one: from the form, a duplicate, an
    agent's `vaubaan__issue_mission` or the v4 import. Giving an expired mission a new end (an edit or a granted
    extension) counts as adding one.
- **At or above a ceiling**, the instance keeps working: nothing existing is removed, disabled or
  stopped, and only the additions of that count are refused, until enough items are removed or
  revoked by the people of the instance. A ceiling lowered under the current count is accepted at
  startup.
- **The refusal names the ceiling** and the count ("This gateway holds 3 active missions, its
  ceiling is 3"); for an agent calling `vaubaan__issue_mission` it is a refusal code of its own. The
  administrator sees each count against its ceiling in the settings.

**Counters.** `GET /ops/stats` answers counts only, for the operator's monitoring: users, accounts
(total and by service), active missions, calls of the current day (UTC) allowed and refused, the
store's size on disk, the current key version and how many sealed values each key version still
holds, and the configured ceilings. Never a name, an e-mail, an identifier of an item, a resource or a
configuration value. It is opened by `ops.token`, a secret of at least 32 characters sent as a bearer
token; without that key the endpoint does not exist (404), a wrong or missing token is refused (401)
without saying more, and while the instance is in setup it answers that it is not ready (503).

### 4.4 Bootstrap kit after issuance

After issuance the interface shows the key, then numbered snippets to copy and a verification
command, in the interface's words (commands, variable, tool names and codes keep the protocol's):

1. The environment variable carrying the token. Revealed once; the revisited kit shows it masked.
2. The client's MCP configuration (instance URL, authorization header referencing the variable).
3. An instruction block for the agent: whose key it holds, accounts, resource refs (and, for a
   whole account, that later resources are reached), accepted risks, budget, what to do on each
   refusal (hand the request URL to the human, never work around it) and when the key itself stops
   working.
4. When the mission holds repositories served by the git remote: a credential helper reading the
   variable, the recommended rewrite of each service's git URLs to its path on the instance
   (`<instance>/git/<service>/`), and each repository's remote. The mission page shows the same remotes and what git may do.

A generic page served without authentication documents the same for any agent, with no mission's
values.

## 5. Composition

- **[gateway-risk-model](./gateway-risk-model.md)** — plugins, risk catalogs, slices, scope caps,
  `risk-not-accepted`, the speed mechanism. This spec adds the cumulative quota and the mission log.
  Stateless scope caps are not enforced: shipped risk catalogs declare none
  ([scope-caps-amplification-axis](../decisions/scope-caps-amplification-axis.md)). Where that
  document says binding, project policy or project-scoped root token, read: resource of an
  account, share restriction, mission.
- **Plugins** — one per service: classify `(tool, arguments) → slices` and execute with an
  ephemeral credential. Each declares its one way of connecting (a pasted key with its form, check
  and guide; a key pair the instance generates; or the service's sign-in), how to withdraw the grant
  on revocation (or where a person removes it), how to discover resources and which tools create
  one, and its macro-actions. Contribution: [CONTRIBUTING](../../CONTRIBUTING.md),
  [plugins/README](../../plugins/README.md). Writing one:
  [plugin-authoring](./plugin-authoring.md). Every published plugin comes from one public
  **catalog**: a declaration per plugin naming its source and exact revision, added by a reviewed
  change; the catalog rebuilds each declared revision itself and signs the archive, so "signed by
  Vaubaan" means built by the catalog from reviewed source
  ([ADR](../decisions/plugin-catalog-rebuilt-from-source.md)). The image carries no service
  plugin: only the management plugin and a plugin that cannot be archived (`ssh`) are compiled
  into the server, and a catalog plugin is installed when a person first connects its service
  ([ADR](../decisions/plugins-installed-when-first-needed.md)). A **private** plugin is built
  outside the catalog and signed with its author's own key, which an instance trusts by naming it
  a signer; its existence is published nowhere. A plugin reaches an instance installed when a person first
  connects its service, installed by an administrator (uploaded, or from the catalog in one click), or
  pinned by the operator in the plugins directory, the pin winning over the others of its id
  ([ADR](../decisions/plugins-bundled-or-pinned-by-the-operator.md)). It runs in the process with
  the credential, so it runs only signed by Vaubaan when a person first connects its service, once an administrator
  activated it, or once the operator placed it, and its archive is checked against its signature at every start; a signature says who built the
  plugin, never that it is harmless
  ([ADR](../decisions/plugins-activated-by-an-administrator-on-trial.md),
  [ADR](../decisions/plugin-signature-sets-the-trust-level.md)).
- **Sign-in providers** — authenticate humans with subject, verified email and, for a directory,
  groups. Trusted for their own issuer's identities only, never for authorization.
- **Push services and messaging services** — reached outbound, without an account: a push service
  relays a sealed envelope it cannot read to the person's device; a messaging service receives what
  the person's address accepts. The instance holds the subscription or the address, nothing more.
- **Services** — the connect flow runs between user, service and instance, no third party. A
  mailbox plugin may sign in with an app password; nothing is ever sent by mail.
- **Community collector** — receives consenting instances' reports, publishes aggregates (§9).
- **MCP clients** — any; the gateway knows the mission, not the client.

## 6. Security

- **One trust domain.** The operator has access, in running memory, to decrypted credentials during
  a call
  ([trust-model-clear-at-rest-idp-style](../decisions/trust-model-clear-at-rest-idp-style.md)).
- **Encryption at rest.** Account credentials are encrypted with a key derived from the master
  key, unique per account, the account id as authenticated data. The master key never lives in
  the store and leaves the process environment once read. Rotation reseals every stored secret, then
  the previous key is removed
  ([master-key-rotation-reseals-every-blob](../decisions/master-key-rotation-reseals-every-blob.md)).
- **Backups**
  ([scheduled-encrypted-backup-to-object-storage](../decisions/scheduled-encrypted-backup-to-object-storage.md)).
  A backup is a consistent copy of the store. A scheduled backup is encrypted under a key derived
  from the master key (the bucket holds ciphertext only), checked before it leaves (restored aside,
  integrity checked, every sealed secret opened) and uploaded only if it passes. The latest backup's
  outcome is shown to administrators and, without secrets, on the health endpoint; each backup and
  failure is in the activity. Restore accepts an encrypted backup with its checksum and opens it
  with the key versions it names. Backups beyond the configured count are deleted; nothing else in
  the bucket is touched.
- **No credential to the executor.** §2.4. No read returns a secret value under a non-secret risk:
  an answer that may carry secrets passes an allow-list of non-secret fields (others become
  `[redacted by Vaubaan]`); reading secret values is a dedicated `data: secret` risk, row 2 at least, so
  Careful asks before it.
- **Transport.** Plain HTTP on the local network, behind a TLS termination held by the company.
- **Human authentication.** Each sign-in attempt carries its own `state`, nonce and PKCE verifier
  and is bound to the sign-in provider that started it. A sign-in is admitted only on an email the
  sign-in provider verified, matching its allowed domains, the invitation list or the administrators — or, for a
  tenant sign-in provider without allowed domains, any tenant user. An unverified email never admits nor
  makes an administrator. A sign-in whose groups could not be read is refused, never read as "no
  group" (`groups-unavailable`, `groups-overage`)
  ([users-keyed-by-issuer-and-subject](../decisions/users-keyed-by-issuer-and-subject.md)).
- **Sign-in accounts**
  ([local-accounts-sign-in-provider](../decisions/local-accounts-sign-in-provider.md)): passwords
  hashed with a memory-hard function; a wrong password answered like an unknown address; the form
  rate-limited; a password of at least 12 characters; an account locked 15 minutes after 10 wrong
  passwords in 15 minutes. Creation and reset links are single-use, expire in 15 minutes and are
  stored as digests. Password hashes, second-factor secrets and recovery codes are sealed under the
  master key and never reach a log, the audit or the telemetry.
- **Second factor** before the session exists (a time-based code never accepted twice, or a recovery
  code used once), unless waived for that sign-in provider, never for an administrator. An instance
  in local mode, reached from its own computer only, asks it of the people who enrolled one and
  enrols nobody by force
  ([amendment](../decisions/local-accounts-sign-in-provider.md#amendment-2026-11-25--local-mode-enrols-no-second-factor-by-force)).
- **Recovery by the master key**: a page reachable without a session lets the key's holder do one
  thing, name one administrator or set a new password for one sign-in account (its second factor
  kept, its sessions ended); the key never leaves the browser (it proves holding it against a
  single-use challenge); the act is audited, mailed to the administrators when the instance sends
  mail, and shown on every page for thirty days.
- **Web sessions** are bound to the instance's origin and last 8 hours at most, 1 hour idle; a
  person, or an administrator for them, can end all their sessions at once. Every mutation requires
  a valid session and an origin check.
- **No self-lockout**: unmaking an administrator, deactivating a person, switching off or removing a
  sign-in provider are refused when they would leave no administrator a way in.
- **What a service says stays with the agent.** A service's error text reaches the calling agent
  only; the instance logs, stores and shows the status in its own words
  ([provider-error-text-stays-with-the-agent](../decisions/provider-error-text-stays-with-the-agent.md)).
- **Browser hardening set by the instance itself**, whatever TLS terminator is in front: a
  Content-Security-Policy admitting only the instance's own scripts and forbidding framing,
  `nosniff`, a same-origin referrer policy, a permissions policy granting no device, HSTS when the
  public URL is https.
- **Separation of the two credentials.** The mission token opens the execution surface (the MCP
  door and the git remote) only, the web session the interface only; requests are granted only in
  a web session. An executor can neither claim for itself nor approve itself.
- **An executor cannot modify its mission.** No tool edits a mission. A mission holding a Vaubaan
  account (§4.1 bis) never rotates nor revokes itself, and a mission it issues never carries a
  Vaubaan account: checked by the host at every call, whatever the stored selection says, like the
  instance's own resources ([ADR](../decisions/platform-management-is-a-plugin-on-the-execution-door.md)).
  Only the creator's own key or a machine key calls those tools. Every mission issued this way
  names, on the mission and in the audit, the mission that prepared it, and acts in the creator's
  name only.
- **Authoritative, atomic counting.** Budget decision and decrement are one operation: two
  concurrent calls on a quota's last credit give exactly one allow and one refusal
  ([atomic-budget-accounting](../decisions/atomic-budget-accounting.md)).
- **Anti-replay and anti-redirect** on service authorization flows: single-use nonce, return URL
  limited to the public URL.
- **A pasted token is checked at the service before it is stored**; a call the service refuses for a
  permission the token lacks is reported naming what it needs. The gateway narrows nothing itself:
  the mission's decision narrows a call.
- **Notifications carry no decision and no secret.** A yes is given in a web session only; a
  notification names a mission and a tool, never an argument (§4.2 bis). Device subscriptions,
  messaging addresses and the signing key pair are sealed under the master key and reach no log,
  audit or telemetry.
- **Surface rate limits** per mission on the MCP endpoint (shared by its tokens), per user on
  connect flows (ten attempts a minute), per address on the request page and every anonymous
  surface.
- **Mission tokens at rest**: only a SHA-256 digest is stored
  ([mission-token-sha256-digest](../decisions/mission-token-sha256-digest.md)).
- **No secret in logs.** Mission tokens are logged by prefix; arguments only hashed.
- **Immutable audit.** No update or delete from the application; purge by retention only (§8).
- **Leak-free telemetry.** §9.

## 7. Workflows

### 7.1 Install an instance

The operator deploys the image with its configuration (§4.3) — one person on their computer runs it
in local mode with one command and no other key, and their setup is two screens: keep the key,
then create their account (email and password), which turns sign-in accounts on, makes them the
administrator and finishes the setup — opens setup with the bootstrap token
(typed, or in a setup link's fragment so it reaches no log), keeps the master key when the instance
generated it, names the first administrator (setup creates a sign-in account, or the admin rule or a
passed sign-in provider test names them), switches a tested sign-in provider on, and **finishes the setup**:
an explicit step, allowed once the key was handed over and an administrator has a way in, that
revokes the bootstrap token.

The desktop app tells the person when a release is out, with its notes and marked when it fixes a
security issue, and installs it only when they accept: the instance stops, the app is replaced and
opens again on the same store, key and accounts. An update that fails leaves the running version in
place; nothing is downloaded without the person's yes.

### 7.2 Connect an account

A user picks a service and lands on the one place that authorizes it
([one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md)):
a key the person makes and pastes whenever the service allows one, with a guide derived from the
plugin (each step's menu path at the service highlighted, and a screenshot with its provenance on
the one hard screen when the plugin declares one); else the service's own sign-in, through a client the gateway registered or through the
broker that serves the service (§4.2, Administration › OAuth brokers); a service no broker serves reads
"not configured", with the way to Settings for an administrator. A pasted
token is checked before it is stored, never shown back, its expiry warned 14 days ahead. An account
connected a way its plugin no longer offers runs nothing until its owner reconnects it, keeping
resources and shares.

A person who has created no mission yet lands, once the account is connected, on the creation form
filled in for it (§7.4, the starter mission), whichever way the account signs in; anyone else lands
on the account's page.

### 7.3 Give access

The owner picks a person or team and ticks permissions; the target sees the account under "Shared
with you". When the access would ground orphaned missions again, it is given only once the owner
confirmed their list.

### 7.4 Create a mission

Accounts, resources, macro-actions at a trust level per account, adjustments, period (default daily) and end (default
never), then "Create mission", with no confirmation (the explicit list is what is sent and checked
again); the key is revealed once with the setup kit.

The **starter mission** is the creation form filled in for one account
(`/missions/new?account=<id>`): a name from the account, the whole account, every macro-action of
its catalog ticked at Careful, then each line that reads set to `auto` and each line that writes or
destroys set to `approval`; what Careful leaves out (row 4) stays out and the form says so; the
default period and end. A prefill the person sees and may change, never issued by itself. After the
key is shown, the page waits for the first call made with that key and says what became of it,
with no reload: the agent is connected (it listed its tools), then its first call was allowed,
waits for the creator's yes, or arrived and was refused, with the reason in one sentence and the
way to the mission's activity. A refusal is never announced as a plain arrival.

### 7.4 bis Edit a mission

The task grew: the creator edits the prefilled screen and saves; the agent keeps its key and
mission log, and its next call sees the edited mission.

### 7.4 ter Restore a version

An edit went wrong: the creator opens the mission's History, reads what each version changed,
and restores the one that worked; it becomes the newest version, within what they may still give,
and the agent's next call sees it, with the same key.

### 7.5 Execute

The first call creates the mission log; every allowed call decrements the touched risks' counters and is
audited.

### 7.6 Exhaust and claim

`budget-exhausted` carries the claim URL; the creator, notified on their channels, decides and the
agent replays. A wrong limit is changed on the mission, not answered each period.

### 7.7 Approve an action

`approval-required` carries the request URL; the creator, notified on their channels, opens the
request page, reads tool and arguments and grants; the agent replays the same call.

### 7.8 Revoke and rotate

The creator stops a mission or replaces its key. An owner removing an access or disconnecting an
account takes that account from the missions using it; those left with nothing become `orphaned`.
The mission page says which account it lost and whether it returns.

### 7.9 Work with several agents

An orchestrator hands its sub-agents its MCP configuration as is; each may set its agent label.

### 7.9 bis Work on a mission as a team

The creator adds teammates
([mission-members-and-per-holder-tokens](../decisions/mission-members-and-per-holder-tokens.md));
each generates their own key, and every call is attributed to its holder. A machine without an
account gets a machine key. A teammate who leaves loses their key at once.

### 7.10 Have an agent prepare a mission

A user connects their Vaubaan account (one click), creates the platform management mission the
account page offers (prefilled in the creation form, every macro-action at Careful) and gives its
key to their agent. The agent reads the authority and the risk catalogs, previews, issues — asking first
where the mission says so. The new mission appears under the user's name, marked as prepared by the
platform mission; it never holds a Vaubaan account.

### 7.11 Update a plugin

A service changes its API overnight; every call of that plugin fails upstream. The agent sees the
service's error and says so; nothing is counted against the budget. The mission's holder reads in
Activity that the calls fail at the service, not at the policy, and has nothing to change. The
plugin's author publishes a new version through the catalog; an advisory names it when the fix is
a security one. The administrator learns it in Administration › Plugins from the versions feed and
chooses the moment: Update on the plugin's row, or Update all when several are behind, and one
confirmation (nothing to type for a version Vaubaan signed). The version starts on trial and the
previous one keeps serving by itself if it does not load; a plugin opted into automatic security patches does the same alone and
notifies the administrators, and a pinned plugin changes when the operator changes the directory.
Missions, accounts, policies and the audit are untouched. The agent replays the call. Either it
runs, or the new version classifies it under a permission the mission does not hold and the call
is refused with a permission request the holder answers in the interface (§3.3 bis), or the
service now wants another grant and the account runs nothing until its owner reconnects it
(§7.2). A version never reaches an instance without an administrator's choice, and neither a newer nor
an older version ever widens what a mission may do.

## 8. Audit

One entry per call, allowed or refused, and per administrative act.

- **A call**: timestamp, mission, token and its holder, account and resource ref, tool, argument
  hash, slices executed, risks touched, snapshot of accepted risks (each distinct snapshot stored
  once, [audit-risk-snapshot-stored-once](../decisions/audit-risk-snapshot-stored-once.md)),
  decision and refusal reason, approval consumed, remaining budget after the call for each risk it
  touched, agent label, upstream latency, bytes sent to the service and received from it (a
  forwarded call only: what the arguments or a git push's pack weighed, what the result or a fetch's
  pack weighed; nothing for a refused call), client origin. Risk field shapes:
  [gateway-risk-model](./gateway-risk-model.md) §12.
- **An administrative act**: timestamp, user, act, object, previous and new state when meaningful,
  and, when it came through the `vaubaan` plugin (§4.1 bis), the mission whose key made the call
  (that call is also in the mission's own activity, like any call). Acts include every change of
  account, share, mission (issuance, edit, extension, reset, approval, rotation, a lost or
  regained account naming the human whose act did it, orphaned or restored), member,
  administrator, admin rule, sign-in provider, second factor, master-key recovery and configuration.
  Entries written by the retired management door keep naming its client (history).
- **Who reads what**: a user reads the entries of missions they created, of missions they are a
  member of now (a removed member reads none, past ones included) and of accounts they own; an
  operator reads every entry, and alone those about groups and users; the bootstrap token reads
  administrative entries and no call. Nobody reads arguments; their fingerprint is shown only to who
  answers for the call (the mission's creator, an owner of its account).
- **Retention** is configured, 90 days by default; no cold archive. It also purges mission log history
  (timeline events, counters of periods ended longer ago) and never what the current period rests on
  (its counters, gates opened until it ends, credits given back by granted claims). A one-off
  mission's counters stay as long as the mission. The versions of a mission's configuration
  (§4.2 "History") are not audit: retention never purges them; they stay as long as the mission
  ([mission-versions-kept-with-the-mission](../decisions/mission-versions-kept-with-the-mission.md))
  and are in every backup.

## 9. Community telemetry

Plugins cannot be tested against real services in the automated suite; trust comes from usage.
Mechanics and decisions: [telemetry handbook](../handbook/telemetry.md); receiving side:
[website](./website.md) §3.

- **Opt-in per instance**, off at installation, set by the operator, visible in the interface:
  **off**, **plugin-health**, **plugin-health + usage-stats**.
- **Level `plugin-health`** — one report per call a plugin executed: plugin id and version, gateway
  version, tool name, outcome (`success`, `upstream-error`, `classification-error`,
  `execution-error`), normalized error class, duration bucket (`<100ms`, `<1s`, `<10s`, `>=10s`).
- **Level `usage-stats`** — in addition: one **decision report** per call decided (plugin id, tool
  name if the plugin declares it, gateway version, decision, the `RiskId`s touched without their
  environment qualifier, whether a gate applied); one **instance profile** per UTC day (gateway
  version, deployment kind, runtime version and architecture, enabled plugins and versions, kinds of
  sign-in providers, bucketed counts), carrying the **instance identifier**.
- **Instance identifier** — 128 random bits (32 hex characters) the gateway draws the first time it
  needs one and keeps in its store; an administrator sees it and can regenerate it in
  Administration → Telemetry. It travels in the instance profile only, so only at `usage-stats`,
  never in a plugin-health or decision report: no call is attributable to an instance. It lets the
  community count the gateways running a plugin version over the window.
- **No report carries a time.** The collector stamps arrival, truncated to the UTC hour.
- **Never**, at any level: arguments or their hashes, payloads, service responses, error text,
  resource refs, environment labels, mission or user identifiers, emails, account or host names,
  URLs, a network address, any identifier of the instance on a call. Every field is a
  closed-vocabulary value, a shape bounded by the plugin's declaration, a bucket, or the instance
  identifier of the profile.
- **Public aggregation**: calls and success rate per `(plugin, version, tool)` — the rate leaves out
  calls refused for a rejected credential, which are the user's configuration, not the plugin —;
  gateways per plugin, plugin version and minor over the window (distinct instance identifiers);
  reporting instances per day. A plugin is **deemed validated** above a published success threshold
  and minimum report count; the interface shows the status on each account and in Reference. Other
  usage statistics are for the maintainers ([website](./website.md) §5).
- The collector never stores a network address nor a field a report does not define. Each level's
  content is published word for word on the trust center.

## 10. Tests

- **Unit, mandatory**, on:
  - each plugin's classifier, against recorded or doc-built service responses (a classification
    error is a security hole);
  - authority composition (§3.1): monotonicity, union of shares, partition per account, resource
    selection and `resource-not-in-mission`, environment resolution against labels;
  - the budget (§3.2, §3.3): multi-risk decrement, rollover on read, atomicity on the last credit,
    concurrent agents on one token;
  - the approval (§3.5): binding to the exact argument fingerprint, single use, expiry, whole
    refusal of a multi-risk call, gate opening bounded to the period, erasure of arguments after
    decision;
  - structured refusals: every code, field and `hint`;
  - credential separation (§6): a web session at the execution surface, a mission token on a request,
    refused unambiguously; the self rule of a mission holding a Vaubaan account;
  - sign-in accounts (§6): the memory-hard hash verifies the password only; lockout counts wrong
    passwords per account across restarts; a one-time code accepted once within one step of drift, a
    recovery code once, a link once and before expiry; unknown address and wrong password answered
    alike; no secret in a log, audit entry or report;
  - the administrators (§0, §6): the rule applied once while the store names nobody (an upgraded
    instance keeps every administrator of its rule), a changed rule naming nobody by itself, a
    pending address consumed by the first sign-in of its sign-in provider, every act leaving no
    administrator a way in refused;
  - the second factor (§6): enrolled at the first sign-in through any sign-in provider and asked at
    every one after, before the session; waived for a sign-in provider outright or on its token's `mfa`, never for
    an administrator; an earlier sign-in account's factor moved to its person;
  - recovery by the master key (§6): the browser's proof equal to the instance's, a wrong key and a
    replayed challenge refused, the recovery session naming one administrator or setting one password only, the entry, the
    mail and the thirty-day banner;
  - the sign-in provider test (§4.2): no user, session or group written, the tester's session kept,
    another session's callback refused, the verdict computed as a sign-in would, the result usable
    by the tester's session only; a sign-in provider saved off and switched on only after a test passed
    since its last save, refused at sign-in while off;
  - a service's OAuth client (§4.3, §7.2): registered by the instance, secret sealed and never
    echoed; an `oauth2` plugin declaring no registration refused at startup;
  - the mailbox over IMAP (§5): the app password checked by an IMAP sign-in before storage, folders
    found by special use, ids and labels from the classifier's grammar, a draft appended and never
    sent.
- **Integration**, on an ephemeral instance with embedded store and simulated IdP: account,
  share, issuance, claim, approval and replay, revocation, the git remote with the real `git` client
  against a local git server standing in for the service (multi-ref pushes, claimed ref values,
  malformed requests), `orphaned` states, issuance by an MCP client holding a platform mission's key,
  within the user's authority and refusal beyond it.
- **End to end, acceptance criterion for the cutover**: connect the services the team uses, issue
  one mission per code project, run the daily workflow with a coding agent with no unexpected
  refusal ([e2e-tests](../tests/e2e-tests.md)); by hand, outside the automated suite.
- **Structural**:
  - no telemetry report, of either level, contains a forbidden field (§9), and the instance
    identifier travels with the instance profile only;
  - mission log counters agree with the audit;
  - no configuration value is hard-coded;
  - every persisted restriction and `accepted_risks` is an enumerated list, never a wildcard, never
    a preset reference;
  - every risk catalog groups each of its risks but the fallback in exactly one macro-action, and no
    risk catalog ships presets;
  - a user's authority on an account is recomputed from their current group membership, never from
    a snapshot;
  - the git remote admits with the execution door's own admission.
- **Out of scope**: integration tests against real services.

## 11. v1 decisions & open questions

### 11.1 Settled decisions

The rules above are settled; their reasons live in the ADRs they link, and in
[pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md),
[interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md),
[github-sign-in](../decisions/github-sign-in.md),
[gmail-over-imap-with-an-app-password](../decisions/gmail-over-imap-with-an-app-password.md) and the
telemetry decision linked from §9. A question an ADR settles leaves §11.2.

### 11.2 Open questions

Not decided, or a v1 assumption usage may overturn.

- **Local groups.** Without sign-in provider groups, may any user create a group? v1: operator only.
- **Transfer to a group one is not a member of?** v1: no; the operator can through `unowned`.
- **Quantities in shares.** Should a share carry a budget ceiling per risk? v1: no; revisit if
  beneficiaries grant themselves unreasonable budgets.
- **Transitive sharing.** v1: no, only the owner shares.
- **Answering from a notification.** v1: none, not even a refusal. Revisit if creators ask to
  refuse from the lock screen without opening the interface.
- **Notification digest.** v1: one notification per event. A daily mail digest for alerts?
- **Gate in shares**, approved by the account owner? v1: no, the gate lives in the mission.
- **Resources in shares.** v1: no; a beneficiary may touch any resource within the shared risks.
- **Agent label.** How a client transmits it, and whether an orchestrator imposes it on sub-agents.
- **Scope of the management tools.** Missions only in v1; sharing stays a human gesture.
- **Per-tool discovery.** Should plugins declare per tool the risks it can touch, so a mission lists
  only what it can call (§4.1)?
- **Audit export.** Format and scope beyond local retention.
- **Who answers when the creator is away** (research Q4). v1: only the creator (§3.4), which keeps
  one responsible human per mission; a teammate lives an expired request as an outage. Assume it,
  or let the creator name a stand-in among the members? A rule to settle, not to patch.
- **The demo and the local instance** (research Q3). Are the simulated demo and a real instance on
  one computer one thing or two? If the local instance ships with a simulated service already
  connected, the demo becomes the first minute of the real product.
