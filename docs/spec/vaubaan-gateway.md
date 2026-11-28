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

## Sections

One file per section; the numbers are the ones the code and the docs cite (`spec §4.3 bis`).

- [§1 Vision](vaubaan-gateway-01-vision.md)
- [§2 Domain](vaubaan-gateway-02-domain.md)
- [§3 Authority — composing restrictions](vaubaan-gateway-03-authority.md)
- [§4 Format / Layout](vaubaan-gateway-04-surfaces.md)
- [§5 Composition](vaubaan-gateway-05-composition.md)
- [§6 Security](vaubaan-gateway-06-security.md)
- [§7 Workflows](vaubaan-gateway-07-workflows.md)
- [§8 Audit](vaubaan-gateway-08-audit.md)
- [§9 Community telemetry](vaubaan-gateway-09-community-telemetry.md)
- [§10 Tests](vaubaan-gateway-10-tests.md)
- [§11 v1 decisions & open questions](vaubaan-gateway-11-decisions-and-open-questions.md)
