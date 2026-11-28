---
title: Vaubaan Gateway spec §1 — Vision
status: draft
---

# Vaubaan Gateway spec — §1 Vision

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §1").

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
