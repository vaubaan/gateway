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

## 0. The idea — accepted risks, not granted capabilities

The delegating human states **which consequences they accept**, from a short list of named risks per
provider, written by the plugin author and reviewed like code.

- **Default deny.** A call is allowed only if every risk it touches is accepted. A call that touches
  nothing the catalog knows is refused.
- **Plugins classify, the gateway decides.** A plugin knows its provider and nothing about missions,
  accepted risks or budgets.
- **Always an enumeration.** Accepted risks are explicit identifiers. No wildcard, no "everything"
  sentinel, at any level.

## 1. Three pillars and one decision

- **Plugin** (per provider): a data model (§2) and a classifier,
  `(tool, arguments, resources) → slices`.
- **Catalog** (per provider, static, versioned): risk entries, one fallback, presets (§4).
- **Mission policy** (per mission): `RiskId → (budget, gate)`; the keys are the accepted risks.
- **Decision** (per call): (1) slices = classify; (2) risks touched = the entries those slices
  match, each qualified by the environment of its slice; (3) risks touched ⊆ accepted risks, else
  `risk-not-accepted`; then budget, gate, execution; (4) one audit entry, allowed or refused.

Steps 1 to 3 are **stateless**: they read the call, the catalog and the mission only.

## 2. The data model, per plane

Each **plane** of a provider (a repository, a database, a mailbox) declares its entities and how
they nest; slice paths name them. Each provider's model is in its handbook
([providers](../handbook/providers/README.md)).

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

At most one entity of a provider's data model carries the environment (the project, a hosting `env`,
the account mode, the mailbox…; none for some). Each provider handbook names it. Resolution at call
time: §6.

## 3. Slices

**A slice is a path over the data model plus an action, read or write.** The plugin emits them, the
catalog matches them, the audit records them. A mission creator never writes one.

### 3.1 Grammar

```
slice    ::= provider '.' segment ('.' segment)* '.' action
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
- No regular expressions, predicates or operators. Provider and action are never wildcards.

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

The dictionary of what a human may accept for one provider. One entry is one business intent that
fits in a sentence; fine-grained intents, never one broad risk covering everything.

### 4.1 An entry

- `id` — the `RiskId`, `<provider>.<name>`; `label` shown to the human; `reason` — why it is a risk.
- `matches` — one slice pattern or a list; the entry is touched when any intersects a slice.
- `vector` (§4.2) and `vector_overrides` per environment
  ([per-env vector](./risk-entry-per-env-vector.md)).
- `acceptable_in_envs` — its presence makes the entry env-scoped (§4.4).
- `fallback` (§4.3); `deprecated` and `replaced_by` (§4.5); `caps`, `infra_limits` (§4bis).
- Entries may overlap on purpose: a slice touching a broad read risk and a narrower sensitive one
  needs both accepted.

### 4.2 The vector

Six axes, each a closed scale from mildest to most severe:

- `reversibility`: `reversible` · `costly` · `irreversible`
- `blast`: `single` · `env` · `account` · `bulk`
- `data`: `metadata` · `data` · `secret` · `pii`
- `cost`: `free` · `moderate` · `unbounded`
- `visibility`: `internal` · `team` · `public`
- `persistence`: `stateless` · `session` · `posture`

The vector **explains** and **orders** risks. No decision is derived from it.

### 4.3 The fallback entry

- Every catalog declares **exactly one** fallback, `<provider>.uncategorized-…`, matching
  `<provider>.**.W`, flagged `fallback: true`; zero or two and the catalog does not load.
- **It counts only when nothing else matched**, slice by slice: named entries match → only they are
  touched; else a write → the fallback; else a read → refused as a catalog gap.
- **No preset includes it**; a creator may accept it by hand. Its presence in the audit means an
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
  matches, so missions holding it keep working; "select all" skips it; a preset referencing it is
  refused.

### 4.6 Presets

A catalog ships **at least one preset**: a named, described list of its `RiskId`s, each with a
default quota, rate limit and gate. An unqualified env-scoped risk in a preset stands for it in each
environment the mission reaches. A catalog is refused when a preset:

- references a risk of another provider or one the catalog does not declare, the fallback, or a
  deprecated entry;
- contains anything but explicit ids, or qualifies an environment the entry does not list or an
  account-scoped entry;
- repeats a risk, is empty, or shares its identifier with another preset;
- has a budget that is not a positive whole quota and a positive whole rate over a positive whole
  window, or a gate outside the closed set.

## 4bis. Scope caps — designed, not enforced in v5.0

- Speed and volume are bounded by the mission, per accepted risk (quota and rate limit,
  [vaubaan-gateway](./vaubaan-gateway.md) §3.2): the model's one speed mechanism.
- One catalog limit applies: the per-minute ceiling of `infra_limits`; no mission is issued with a
  rate limit above it.
- Nothing else: `caps` and the other `infra_limits` keys narrow nothing, so shipped catalogs may not
  declare them. Decision:
  [scope-caps-amplification-axis](../decisions/scope-caps-amplification-axis.md).

## 5. What a mission carries

Its connections (one provider each); per connection its resources (ref, optional environment label);
its policy, one explicit entry per accepted risk, env-scoped risks qualified. No slice, pattern,
explicit deny or preset reference.

## 6. Environment resolution

Each slice gets at most one environment, in this order:

1. **Derived by the plugin** when the environment is part of the call (an `env[prod]` segment),
   whatever the resource's label. A slice spanning several environments derives none.
2. **Otherwise the label of the resource the slice names** (the first identifier equal to a mission
   resource's ref); naming none, the label of the mission's only resource of that provider; with
   several, none. Resources of one call naming several environments resolve to none.
3. **Otherwise none.**

**An unlabelled resource is never a safe default**: an env-scoped risk touched with no environment,
or one the entry does not list, is refused; only account-scoped risks pass there.

## 7. The plugin — classification

- From the tool, the arguments and the mission's resources on the connection, a plugin returns the
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
2. **Free-form SQL is read-only, guaranteed by the provider**, not proven by the classifier; writes
   go through dedicated tools, migrations are read statement by statement and fail closed. **Reading
   provider-managed schemas** (auth users, secret vault, storage internals) is a risk of its own in
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

Checked at draft and again at issuance. Per connection, each requested risk may be **unknown** (not
an explicit id of the catalog), **duplicate**, **exceeds authority**, **unresolvable** (an
environment no selected resource carries, on a provider that does not derive it), **budget missing**
or **budget invalid** (not positive whole numbers, gate outside the closed set, rate above the
catalog ceiling). Any finding blocks issuance, reported with its risks.

- A preset taken as is is intersected with what the creator holds: entries exceeding authority or
  unresolvable are left out and reported, not findings.
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

## 14. Pitfalls and guards

- **A branch or path name chosen by the agent**: a naming pattern bounds the entity, not the act; a
  file under `feature/*` never touches protection.
- Every other guard is a rule above: the fallback (§4.3), bulk markers (§2.1), unlabelled resources
  (§6), left-out tools (§7.2), declared limits (§4bis).

## 15. What is checked mechanically

- **At catalog load** any finding stops the gateway, with its location: malformed fields; an id not
  `<provider>.<name>`, duplicated or with a wildcard; a pattern that does not parse or names another
  provider; a vector axis missing or out of scale; an invalid environment label; a fallback breaking
  §4.3; no preset, or one breaking §4.6.
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
