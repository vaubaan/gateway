---
title: Vaubaan Gateway spec §7 — Workflows
status: draft
---

# Vaubaan Gateway spec — §7 Workflows

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §7").

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
