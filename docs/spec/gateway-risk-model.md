---
title: Gateway risk model — plugins, slices, catalogs, the decision
status: stable
---

# Gateway — risk model

> **Status:** stable. One question: _which risks does a call touch, and does the mission accept
> them?_ Who may accept a risk, how many times, how fast and under whose eyes is
> [vaubaan-gateway](./vaubaan-gateway.md). Decision:
> [pivot-to-risk-based-model](../decisions/pivot-to-risk-based-model.md). Section numbers are cited
> by code: keep them.
>
> **History:** 2026-10-31 — the trust level (Careful, Trusting, Autonomous) and the tier of §4.6 got
> their English names before publication, a breaking rename in the alpha window (owner decision,
> recorded in the History of
> [macro-actions-and-trust-levels-prefill-the-policy](../decisions/macro-actions-and-trust-levels-prefill-the-policy.md));
> what each trust level writes did not change.
>
> 2026-11-20 — row 2 is named "Worth a look" (was "Repairable, worth a look"), owner decision;
> its number, branches and gates did not change.
>
> 2026-11-13 — the gate of a permission comes from an explicit decision tree over five facts (§4.6);
> the `persistence` axis left the catalogs (§4.2) and the severity word (low, medium, high,
> critical) left the product: a permission is printed with its row and the reason that put it there
> (owner decision, recorded in the amendment of
> [macro-actions-and-trust-levels-prefill-the-policy](../decisions/macro-actions-and-trust-levels-prefill-the-policy.md)).

## Vocabulary

Unnumbered: the sections below keep the numbers the code cites. Mission, mission policy, RiskId,
macro-action, trust level and environment are defined in [vaubaan-gateway](./vaubaan-gateway.md) §0.

- **Risk** — a consequence a human may accept for a service, named by a risk entry; accepted, never
  granted (§0).
- **Risk catalog** — per service, static and versioned, reviewed like code: the risk entries, one
  fallback entry and the macro-actions (§4).
- **Risk entry** — one business intent of a service that fits in a sentence: its `RiskId`, the
  slice patterns it matches, its vector and where it is acceptable (§4.1).
- **Plane** — one domain of a service's data model (a repository, a database, a mailbox), declaring
  its entities and how they nest (§2).
- **Virtual leaf** — a slice segment naming an act rather than an entity (`merge-into`) (§2.1).
- **Environment carrier** — the one entity of a service's data model that carries the environment,
  if any (§2.3).
- **Slice** — a path over the data model plus an action, read or write: emitted by the plugin,
  matched by the catalog, recorded by the audit, never written by a person (§3).
- **Classifier** — the plugin's function `(tool, arguments, resources) → slices` (§1, §7).
- **Vector** — the five facts of a risk (reversibility, blast, data, cost, visibility), each on a
  closed scale; the catalog author's method to sort a risk into a row, never a score (§4.2).
- **Vector override** — the axes of an entry's vector that differ in one environment
  ([per-env vector](./risk-entry-per-env-vector.md)).
- **Fallback entry** — the one entry of a catalog that takes the writes nothing else matched; its
  presence in the audit means an entry is missing (§4.3).
- **Env-scoped entry** — an entry listing the environments where it is acceptable, offered, accepted
  and compared qualified (`railway[staging].deploy`); without the list, an **account-scoped** entry
  (§4.4).
- **Row** — one of four classes, from Harmless to Cannot be repaired, read from the vector by a
  decision tree; pre-fills a gate and orders the lists of the interface (§4.6).
- **Reason** — the branch of that tree which put a permission in its row (§4.6).
- **Base budget** — the quota and rate limit an entry carries in its macro-action, multiplied by
  the trust level (§4.6).
- **Resource set** — a part of a mission's account: its resources, of one environment, its
  macro-actions at their trust levels, its explicit policy and its own budget counters (§4.7).
- **Trust-raise proposal** — the offer to raise a macro-action's trust level by one, after 10
  approvals with no refusal (§4.7).

## 0. The idea — accepted risks, not granted capabilities

The delegating human states **which consequences they accept**, from a short list of named risks per
service, written by the plugin author and reviewed like code.

- **Default deny.** A call is allowed only if every risk it touches is accepted. A call that touches
  nothing the catalog knows is refused.
- **Plugins classify, the gateway decides.** A plugin knows its service and nothing about missions,
  accepted risks or budgets.
- **Always an enumeration.** Accepted risks are explicit identifiers. No wildcard, no "everything"
  sentinel, at any level.

## 1. Three pillars and one decision

- **Plugin** (per service): a data model (§2) and a classifier,
  `(tool, arguments, resources) → slices`.
- **Catalog** (per service, static, versioned): risk entries, one fallback, macro-actions (§4).
- **Mission policy** (per mission): `RiskId → (budget, gate)`; the keys are the accepted risks.
- **Decision** (per call): (1) slices = classify; (2) risks touched = the entries those slices
  match, each qualified by the environment of its slice; (3) risks touched ⊆ accepted risks, else
  `risk-not-accepted`; then budget, gate, execution; (4) one audit entry, allowed or refused.

Steps 1 to 3 are **stateless**: they read the call, the catalog and the mission only.

## 2. The data model, per plane

Each **plane** of a service (a repository, a database, a mailbox) declares its entities and how
they nest; slice paths name them. Each service's model is in its handbook
([services](../handbook/services/README.md)).

### 2.1 Entities, containment, cardinality

- Each entity has a **name** (as in slices), a **parent** in the same plane or none (another plane's
  parent stops the plugin from loading), documentary **cardinalities** (`one`, `bounded`,
  `unbounded`), and optionally **carries the environment** (§2.3).
- Cardinality is not a field of a slice: when one-versus-many changes the risk, the plugin emits a
  literal marker matched by distinct entries (`object[one]`, `object[bulk]`).
- A plugin may emit **virtual leaves** naming an act rather than an entity
  (`branch[main].merge-into`).

### 2.2 Example — GitHub, plane `repo`

`repo` contains `branch` (with `file`, `commit`), `tag`, `release`, `pull_request`, `issue`,
`workflow`, `branch-protection`, `collaborator`, `secret`, `repo-settings`.

### 2.3 The environment carrier

At most one entity of a service's data model carries the environment (the project, a hosting `env`,
the account mode, the mailbox…; none for some). Each service handbook names it. Resolution at call
time: §6.

## 3. Slices

**A slice is a path over the data model plus an action, read or write.** The plugin emits them, the
catalog matches them, the audit records them. A mission creator never writes one.

### 3.1 Grammar

```
slice    ::= service '.' segment ('.' segment)* '.' action
segment  ::= name | '[' inner ']' | '*' | '**'
inner    ::= '*' | '**' | item (',' item)*
name     ::= [a-zA-Z0-9_/-]+              an entity or a virtual leaf
item     ::= [a-zA-Z0-9_./~*-]+           an identifier; '*' inside it is a glob
action   ::= 'R' | 'W'
```

- An identifier follows its name in brackets, no dot: `branch[main]`.
- `[*]` is exactly one identifier; `[**]` or bare `**` is any number of segments, none included.
- `*` inside an identifier globs one or more identifier characters (`[feature/*]`); a list may mix
  exact ids and globs (`[main,master,release-*]`).
- No regular expressions, predicates or operators. Service and action are never wildcards.

### 3.2 Examples

Emitted: `github.repo[acme/api].branch[main].merge-into.W`. Catalog patterns:
`github.repo[**].branch[main,master,release-*].W`, `github.**.W`.

### 3.3 Matching

- Segment by segment: a name matches the same name only; `[*]` one identifier, never a name; `[**]`
  zero or more segments; a glob what it accepts; a list when one item does.
- The decision uses **intersects** (at least one slice accepted by both), since a plugin may emit a
  wildcard slice for a set it cannot enumerate. Two globs that cannot be compared exactly are held
  to intersect: one risk too many, never one too few.

## 4. The risk catalog

The dictionary of what a human may accept for one service. One entry is one business intent that
fits in a sentence; fine-grained intents, never one broad risk covering everything.

### 4.1 An entry

- `id` — the `RiskId`, `<service>.<name>`; `label` shown to the human; `reason` — why it is a risk.
- `matches` — one slice pattern or a list; the entry is touched when any intersects a slice.
- `vector` (§4.2) and `vector_overrides` per environment
  ([per-env vector](./risk-entry-per-env-vector.md)).
- `acceptable_in_envs` — its presence makes the entry env-scoped (§4.4).
- `fallback` (§4.3); `deprecated` and `replaced_by` (§4.5); `caps`, `infra_limits` (§4bis).
- Entries may overlap on purpose: a slice touching a broad read risk and a narrower sensitive one
  needs both accepted.

### 4.2 The vector

Five axes, the facts of a risk, each a closed scale from mildest to hardest:

- `reversibility`: `reversible` · `costly` · `irreversible`
- `blast`: `single` · `env` · `account` · `bulk`
- `data`: `metadata` · `data` · `secret` · `pii`
- `cost`: `free` · `moderate` · `unbounded`
- `visibility`: `internal` · `team` · `public`

The vector is the **catalog author's method** for sorting a risk into a **row** (§4.6), which only
pre-fills a gate in the creation form and orders the lists of the interface. It is never summed and
never scored; no runtime decision is derived from it. A catalog declaring any other axis does not
load (`persistence`, retired on 2026-11-13, included).

### 4.3 The fallback entry

- Every catalog declares **exactly one** fallback, `<service>.uncategorized-…`, matching
  `<service>.**.W`, flagged `fallback: true`; zero or two and the catalog does not load.
- **It counts only when nothing else matched**, slice by slice: named entries match → only they are
  touched; else a write → the fallback; else a read → refused as a catalog gap.
- **No catalog macro-action includes it**; a creator may accept it by hand, or tick the
  gateway's own "Anything else" macro-action. Its presence in the audit means an
  entry is missing. Decision:
  [fallback-risk-only-when-uncategorized](../decisions/fallback-risk-only-when-uncategorized.md).

### 4.4 Qualification by environment

- An entry with `acceptable_in_envs` is **env-scoped**; without, **account-scoped** and never
  qualified.
- The catalog stores the unqualified id (`railway.deploy`); an env-scoped entry is offered, accepted
  and compared qualified, one id per listed environment (`railway[staging].deploy`).
- An environment label is a lowercase slug.
- An entry listing `[preview, staging]` has no `[prod]` form: it cannot enter a share or mission for
  production, and a call touching it there is refused (§8).

### 4.5 Versioning and deprecation

- The catalog changes by pull request, with a `catalog_version` raised on every reviewed change.
- **Adding** an entry: calls it matches are refused for existing missions and shares until the
  creator accepts it. A new risk is never accepted by default.
- **Renaming or removing** an id is forbidden. An entry that must go is `deprecated`: it still
  matches, so missions holding it keep working; "select all" skips it; a macro-action listing it is
  refused.

### 4.6 Macro-actions and trust levels

What a creator ticks per account, in the connector's words
([ADR](../decisions/macro-actions-and-trust-levels-prefill-the-policy.md)):

- A catalog declares **3 to 6 macro-actions** (`id`, `label`, `description`, `entries`); every entry
  that is neither the fallback nor deprecated belongs to **exactly one**, listed unqualified with its
  **base budget** (quota, rate limit; no gate). The gateway adds `anything-else`, holding the
  fallback. A catalog breaking this does not load.
- A macro-action may carry a **`narrative`**: two to four sentences in the connector's words, at
  most 600 characters, saying what an agent does under this verb and why its permissions are cut
  the way they are ("two acts are kept apart because they destroy work"). It is shown on the
  plugin's public page and in the reference, reviewed like the rest of the catalog, and never read
  by the runtime. Shipped catalogs fill it (structural test).
- **Row**, read from the vector in the environment of the line by a decision tree whose branches are
  read in order; the first that answers decides:

  | Row | Name                   | Reached when                                                                                   |
  | --- | ---------------------- | ---------------------------------------------------------------------------------------------- |
  | 4   | Cannot be repaired     | `reversibility: irreversible`                                                                  |
  | 3   | Repairable, at a price | `reversibility: costly`, or `cost: unbounded`                                                  |
  | 2   | Worth a look           | `data: secret` or `pii`, `blast: account` or `bulk`, `cost: moderate`, or `visibility: public` |
  | 1   | Harmless               | none of the above                                                                              |

  The **reason** of a permission is the one branch that decided, in tree order: `irreversible`,
  `costly-to-undo`, `unbounded-cost`, `secret-data`, `personal-data`, `whole-account`, `in-bulk`,
  `moderate-cost`, `public`; none in row 1. The interface prints the row's name and, in quiet type,
  the reason; it orders lists by row, the hardest to repair first, then catalog order. The word
  _tier_ is not printed, and no severity word exists.

- **Trust level**, one per ticked macro-action, `careful` by default:

  | Row | Careful      | Trusting | Autonomous |
  | --- | ------------ | -------- | ---------- |
  | 1   | auto         | auto     | auto       |
  | 2   | approval     | auto     | auto       |
  | 3   | approval     | approval | auto       |
  | 4   | not accepted | approval | approval   |

- The trust level multiplies the base budget ×1, ×3, ×10; the rate stays under the entry's per-minute
  ceiling (§4bis).
- A catalog ships no presets: a `presets` key does not load.
- The result is explicit lines (§5), shown before issuance and editable one by one; the mission
  keeps the trust level per macro-action only to redraw the form.

### 4.7 Resource sets and trust-raise proposals

**Resource sets**
([ADR](../decisions/resource-sets-partition-a-mission-connection.md)).

- An account of a mission holds one or more resource sets. Each set has its resources, its
  macro-actions at their trust levels and its explicit policy, and keeps its own budget counters.
- A resource belongs to exactly one set of its account, and every resource of a set has the same
  effective environment ([ADR](../decisions/resource-set-is-one-environment-with-optional-future-resources.md)).
  A set with **future** on takes the resources that later appear with its environment; a resource
  relabelled out of it leaves it.
- A resource the mission creates joins the set the creating call was judged against. When that call
  had several candidate sets, it joins the candidate set with future on in its environment if there
  is one, else the first of the candidate sets: never a set the call was not judged against.
- **The account of a call** comes before its set, when the mission carries several accounts of the
  call's service: the account the agent names (`vaubaan_account`), else the one holding the
  resources the call names (same reading). An account that no longer serves the mission gives
  way to a serving one holding the same resource: the account connected in place of a
  disconnected one on a repository takes its calls. A call naming neither, or resources of two accounts
  (or of an account other than the one named), is refused `account-ambiguous` before any risk is evaluated:
  one call runs with one credential, and the gateway never picks one for the agent.
- **The set of a call.** A call goes to the sets of the resources each slice names: every identifier
  or list value equal to a mission resource's ref (the reading of §6, step 2). A slice citing refs of
  several sets — an org slug equal to an app's ref, a list of two resources — brings each in.
- **Calls that cannot be placed in one set.** A call that names no mission resource, or resources
  from several sets, goes to every candidate set: all the sets of the account in the first case,
  the named sets in the second. Then:
  - each touched risk must be accepted in every candidate set;
  - the most restrictive gate applies;
  - each set's quota and rate limit are checked and charged.
- Environment resolution (§6) reads the resources of the whole account. The set chooses only
  the policy.
- With one set, the screen shows no set at all.

**Trust-raise proposals.**

- **When one is offered.** After 10 approvals granted on one macro-action of one set, with no
  refusal since its trust level last changed, the mission's page and the Now page offer the
  creator to raise that trust level by one. Any refusal resets the count. The threshold is an
  instance setting.
- **Two answers.** "Raise" opens the ordinary mission edit at the new level, with its preview; it is
  audited like any edit. "Not now" hides the offer until 10 more approvals.
- There is no timed raise, and nothing is ever raised automatically.
- A macro-action already at Autonomous is never offered a raise.
- A raise rewrites the lines of that macro-action at the new level. Lines edited by hand in the
  advanced view are shown in the preview before they are replaced.
- A trust-raise proposal and a budget widening (a repeated claim) are two separate offers that are
  never merged.

## 4bis. Scope caps — designed, not enforced in v5.0

- Speed and volume are bounded by the mission, per accepted risk (quota and rate limit,
  [vaubaan-gateway](./vaubaan-gateway.md) §3.2): the model's one speed mechanism.
- One catalog limit applies: the per-minute ceiling of `infra_limits`; no mission is issued with a
  rate limit above it.
- Nothing else: `caps` and the other `infra_limits` keys narrow nothing, so shipped catalogs may not
  declare them. Decision:
  [scope-caps-amplification-axis](../decisions/scope-caps-amplification-axis.md).

## 5. What a mission carries

Its accounts (one service each); per account its resources (ref, optional environment label);
its resource sets (§4.7), each with its policy, one explicit entry per accepted risk, env-scoped
risks qualified. No slice, pattern, explicit deny, macro-action or trust level.

## 6. Environment resolution

Each slice gets at most one environment, in this order:

1. **Derived by the plugin** when the environment is part of the call (an `env[prod]` segment),
   whatever the resource's label. A slice spanning several environments derives none.
2. **Otherwise the label of the resources the slice names** (every identifier or list value equal to
   a mission resource's ref; labels that disagree give none); naming none, the label of the mission's only resource of that service; with
   several, none. Resources of one call naming several environments resolve to none.
3. **Otherwise none.**

**An unlabelled resource is never a safe default**: an env-scoped risk touched with no environment,
or one the entry does not list, is refused; only account-scoped risks pass there.

## 7. The plugin — classification

- From the tool, the arguments and the mission's resources on the account, a plugin returns the
  slices touched or a refusal of its own (unknown or retired tool, arguments no slice can be built
  from).
- Classification is pure: no network, no credential, no state. It never sees the accepted risks.
- **A classification error is a security hole**: classifiers are unit-tested tool by tool, and a
  classifier that cannot read what a call will do **fails closed**, emitting every slice the call
  could touch.

### 7.1 Several slices per call

A call returns every slice it touches (a pull request and both branches); the risks touched are
their union, all required.

### 7.2 Tools deliberately left out

1. **Dispatching, cancelling or re-running a CI workflow** is not exposed (it runs with the
   repository's secrets); the classifier refuses it by name. A file write on a workflow definition
   is a named risk.
2. **Free-form SQL is read-only, guaranteed by the service**, not proven by the classifier; writes
   go through dedicated tools, migrations are read statement by statement and fail closed. **Reading
   schemas the service manages** (auth users, secret vault, storage internals) is a risk of its own in
   no read preset, decided by what the SQL names; a query the classifier cannot read with confidence
   touches it too.

## 8. The decision

| Situation                                                                   | Outcome                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------- |
| The plugin refused the call                                                 | Refused, with the plugin's reason                       |
| The plugin returned no slice                                                | Refused: classification gap                             |
| An env-scoped risk touched outside its environments, or with no environment | Refused: no mission can hold that risk there            |
| The slices touch no entry at all                                            | Refused: catalog gap                                    |
| A touched risk is not accepted by the mission                               | Refused: `risk-not-accepted`, listing the missing risks |
| Every touched risk is accepted                                              | Allowed; budget, rate limit and gate follow             |

- **All or nothing**; no partial execution, no step-up, a call never modifies the mission.
- **A risk is never dropped to make a call pass**: an env-scoped risk touched where it is not
  acceptable stays in the set, so a broader risk on the same slice cannot carry the call.
- **One code**: every refusal of this step is `risk-not-accepted` (empty missing list for a gap;
  acceptable environments in the hint for an environment cause). Only the plugin's own refusal
  carries no code.
- **Fail closed**: a decision stage that throws is an audited refusal whose reason names the stage
  and the error class, never the message. An executed identifier containing `*` other than exactly
  `*` is denied.

## 9. Checking a policy before issuance

Checked at draft and again at issuance. Per account, each requested risk may be **unknown** (not
an explicit id of the catalog), **duplicate**, **exceeds authority**, **unresolvable** (an
environment no selected resource carries, on a service that does not derive it), **budget missing**
or **budget invalid** (not positive whole numbers, gate outside the closed set, rate above the
catalog ceiling). Any finding blocks issuance, reported with its risks.

- A macro-action at a trust level is expanded into lines first, then checked like any line.
- Macro-actions at a trust level are intersected with what the creator holds: risks exceeding authority
  or unresolvable are left out and reported, not findings.
- A share's restriction is the same kind of list, each id valid by §4.4.

## 10. After the risk decision — budget and gate

Quota, rate limit and gate per accepted risk follow an allowed decision
([vaubaan-gateway](./vaubaan-gateway.md) §3.2–§3.5); they never change which risks a call touches.

## 11. Refusals go up to a human

The executing agent cannot widen its mission; `risk-not-accepted` goes to the creator
([vaubaan-gateway](./vaubaan-gateway.md) §3.5).

## 12. Audit

Fields of this model on every call entry ([vaubaan-gateway](./vaubaan-gateway.md) §8): tool and
arguments hash (never the arguments); **slices executed** (empty when refused before
classification); **risks touched**, qualified; **accepted risks snapshot**, so the decision can be
replayed; decision with code and hint, or reason. No field for scope caps.

## 13. Reading older documents

In decisions written before v5: binding → resource; project policy → share restriction; root or
project-scoped token → mission; child token, delegation chain, denied risks, escalation channel →
none; mint → issue; gates `allow` / `confirm` / `deny` → accepted or not, then `auto` / `approval`.
In documents written before 2026-11-13: tier → row (same numbers, now read by the tree of §4.6);
severity, severity level, low / medium / high / critical, "the most severe" → the row and its
reason, "the hardest to repair"; the six axes, `persistence` → the five facts of §4.2.

## 14. Pitfalls and guards

- **A branch or path name chosen by the agent**: a naming pattern bounds the entity, not the act; a
  file under `feature/*` never touches protection.
- Every other guard is a rule above: the fallback (§4.3), bulk markers (§2.1), unlabelled resources
  (§6), left-out tools (§7.2), declared limits (§4bis).

## 15. What is checked mechanically

- **At catalog load** any finding stops the gateway, with its location: malformed fields; an id not
  `<service>.<name>`, duplicated or with a wildcard; a pattern that does not parse or names another
  service; a vector axis missing or out of scale; an invalid environment label; a fallback breaking
  §4.3; a `presets` key; no macro-action, or macro-actions breaking §4.6 (a `narrative` that is not
  a string of at most 600 characters included).
- **In each plugin's tests**: every tool has a sample call yielding slices its own catalog matches;
  samples landing on the fallback are reported as a missing entry.
- **Across shipped plugins**: no catalog declares a limit the gateway does not enforce (§4bis).

## 16. Open points

- **Stateless scope caps**: whether narrowed or original arguments are fingerprinted, and how a
  capped call is refused when the plugin cannot narrow it.
- **A finer `tools/list`**: the risks of a tool depend on its arguments, so discovery cannot filter
  per tool.
- **Environment from the branch, for GitHub**: allowed by the data model, unused.
- **Identifier characters**: a plugin may put in an identifier a character §3.1 does not accept (an
  email address); the slice matches and is audited but cannot be read back. The two should be one
  set.
