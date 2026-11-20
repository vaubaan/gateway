---
name: vaubaan-risk-catalog
description: Use after vaubaan-model-service, to write src/risk-catalog.yaml: the risks with their slice patterns and vectors, the fallback entry and the macro-actions. Stops for the human on every write risk.
---

# Write the risk catalog

The same step for a person, with its reasons: https://vaubaan.com/docs/plugins-guide/risk-catalog (append `.md` to the path for Markdown). Read it when a rule below is unclear; this skill decides what you do and where you stop.

The catalog is the plugin's security statement: the file a reviewer and an administrator read
first. One entry per **intent that deserves its own decision**, not one per tool or per endpoint.

## Inputs

- `src/data-model.ts` and `src/tools.ts`, as `vaubaan-model-service` left them.
- The service's documentation of what each write does: can it be undone, who sees it, what it costs.

## Steps

1. For each tool, write down the slice it will emit (`<id>.<resource>[<ref>].<entity>[<id>].R|W`,
   a verb leaf where the model has one). A call that touches several entities emits several slices.
2. Group the slices into risks. Reads usually make one or two risks; writes are layered: a broad
   write risk (`<id>.<resource>[**].<entity>[**].W`) plus one risk per dangerous verb leaf
   (`…<entity>[**].delete.W`). Patterns that overlap add up: a deletion then touches both risks and
   a mission needs both. Give two risks patterns that do not overlap when they must not add up.
3. Write each entry in `src/risk-catalog.yaml`:
   - `id`: `<service id>.<name>`, lowercase with dashes. Once shipped, never renamed nor deleted:
     mark it `deprecated: true` with `replaced_by: <id>` instead.
   - `label` (a few words) and `reason` (two sentences at most): people read them as a
     "permission".
   - `matches`: one pattern or a list. `[*]` is one identifier, `[**]` any identifier and anything
     below it, `[a,b]` a list. No regular expression. Every pattern is a path of the data model.
   - `vector`, five facts about what the act does at the service (there is no sixth axis: a
     `persistence` key does not load):
     - `reversibility`: `reversible` | `costly` | `irreversible`
     - `blast`: `single` | `env` | `account` | `bulk`
     - `data`: `metadata` | `data` | `secret` | `pii`
     - `cost`: `free` | `moderate` | `unbounded`
     - `visibility`: `internal` | `team` | `public`

     The gateway sorts a risk into a row, first match wins: `irreversible` → row 4 "cannot be
     repaired"; `costly` or `unbounded` → row 3; `secret` or `pii`, `account` or `bulk`,
     `moderate`, or `public` → row 2; otherwise row 1 "harmless". The row sets the gate at each
     trust level, so the vector decides when a call asks a person first.
   - `acceptable_in_envs: [staging, prod]` when the risk depends on the environment (one entry,
     never two ids with the environment in the name), and `vector_overrides: { prod: {...} }` for
     what changes there.
4. Keep exactly one fallback, last: `<id>.uncategorized-write`, `matches: '<id>.**.W'`,
   `fallback: true`, in no macro-action. It catches only writes no other entry covers. Reads need
   an entry of their own: a read no entry matches is refused.
5. Write `macro_actions`: two to six, named in the service's words ("Read", "Publish", "Manage
   members"). Every risk but the fallback (and deprecated ones) in exactly one, with a base budget:
   `quota` and `rate_limit: { max, window_seconds }`, no gate. Each has a `label`, a one-line
   `description` and a `narrative`: two to four sentences, at most 600 characters, saying what an
   agent does under this verb and why its permissions are cut this way.
6. Set `catalog_version: 1` and `catalog_date` to today. Leave out `presets`, `caps` and any
   `infra_limits` key but `calls_per_minute_max`: they do not load.
7. In `tests/unit/plugin.test.ts`, update the structural kit's expectations that name risks: the
   number of risks touched and the gates of the macro-actions test (`policyFromMacroActions`).

## Stop for the human: each write risk

Before writing any entry whose patterns end in `W`, show the human, for each one:

| Risk id | Tools and slices | Vector | Environments | Macro-action | Quota, rate |
| ------- | ---------------- | ------ | ------------ | ------------ | ----------- |

with one sentence per vector fact saying why, and the row it lands in. Ask them to confirm or
correct each line. Write only what they confirmed. Do not continue on silence.

## Report

The table of every risk (reads included), the macro-actions, and what the human changed.

Done when: `npx vitest run -t 'well-formed'` exits 0.
