---
title: Vaubaan Gateway spec §4 — Format / Layout
status: draft
---

# Vaubaan Gateway spec — §4 Format / Layout

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §4").

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

Before those snippets, the interface offers each agent its own way in
([ADR](../decisions/mission-key-reaches-an-agent-through-its-own-secret-store.md)): one line to
run for Claude Code and one for Codex, which put the key in the agent's own configuration in the
person's home, never in a file of the project, the interface naming that file and saying the key
is revoked from the mission; for Claude Desktop, a file to open and the key to paste once, kept by
the system's secret store. The configuration of step 2 names the variable, never the key: it is
the one a team may commit. The gateway writes into no file of another application.

The door also hands the agent its instructions itself, so that nothing has to be pasted: the MCP
handshake answers with a **short form** of the instruction block (the `instructions` of the
server), and the catalog (§4.1) carries the whole block in `instructions`. The short form says what
a mission is, the accounts it holds, how to read a refusal, how to wait for the creator's yes, that
a refusal is never worked around, and where the whole text is. It stays under 3,500 characters
whatever the mission holds (a client may cut a server's instructions at 4,096): accounts that do
not fit are counted and left to the catalog. The pasted block stays for clients that read no
server instructions.
