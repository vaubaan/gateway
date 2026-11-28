---
title: Vaubaan Gateway spec §2 — Domain
status: draft
---

# Vaubaan Gateway spec — §2 Domain

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §2").

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
