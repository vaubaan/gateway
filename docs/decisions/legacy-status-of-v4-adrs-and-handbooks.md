---
title: Legacy status of v4 ADRs and handbooks
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
  - repository-layout-and-contribution-workflow
---

# Legacy status of v4 ADRs and handbooks

> **Amendment 2026-10-13 (Phase 1 cycle-end).** The v4 handbooks that
> mechanism 1 kept in place moved to `docs/handbook/legacy/` (mechanism 2)
> once their English replacements landed: `auth-github-sso.md` →
> `authentication.md`; `mcp-gateway.md` → `execution-door.md` (and
> `gateway-core.md`); `escalation.md` → `requests.md` (closest successor, the
> escalation concept itself is dropped in v5); `github-provider.md` →
> `providers/github.md`; `vercel-provider.md` → `providers/vercel.md`;
> `railway-provider.md` → `providers/railway.md`; `bash-provider.md` and
> `providers/railway-ssh.md` → `providers/ssh.md` (and `providers/railway.md`
> for the Railway half); `web-app.md` → the new `web-app.md`.
> `permission-threat-model-state-of-the-art.md` (research note, no
> replacement) moved with them. Each moved file is `status: legacy`, has no
> `tracks:` and opens with the legacy banner. The body below is unchanged.

> **Amendment 2026-10-13 (Phase 2 cycle-end)** — where the amendment of an
> ADR goes. See "Amendment 2026-10-13 — the form of an amendment" at the end
> of this document.

> Fixes the mechanics by which the v4 documentation (French, written for
> the multi-tenant SaaS) is marked historical without being rewritten,
> translated or deleted, so that wikilinks keep resolving and the doc
> tooling knows what to ignore. Implemented by feature P0.1.

## Context

The pivot ADR [[pivot-v4-to-v5-on-prem-mission-tokens]] states that the
ADRs it supersedes are not rewritten and that four handbooks
(`auth-github-sso`, `web-app`, `mcp-gateway`, `escalation`) become
historical. Its amendment rules that everything written from v5 on is in
English and that v4 documents are "replaced, not translated".

That leaves a practical question for about thirty ADRs, fifteen
handbooks, three specs and one workflow document: how does a reader, or a
skill such as `doc-audit` or `drift-detector`, tell a v4 document from a
current one, and what happens to the dozens of `[[wikilinks]]` and
relative links that point at them? The P0.1 move of `packages/*` also
invalidates every `tracks:` path in the handbooks.

## Decision

### Two mechanisms, chosen by how the document is replaced

1. **In place, with frontmatter and a one-line banner** — for documents
   that other documents link to by name and that stay where they are:
   - every ADR (ADRs are immutable; only frontmatter fields and a banner
     line are added, the body is never edited);
   - handbooks that remain the only description of a subsystem until its
     English rewrite lands.
2. **Moved into a `legacy/` sibling folder** — for documents replaced
   wholesale by a v5 document that already exists:
   - `docs/spec/legacy/`: `vaubaan-gateway.legacy.md` (archived v4 spec),
     `gateway-capability-model.md`, `project-env-vars.md`;
   - `docs/handbook/legacy/`: `integrations-submission-kit.md` (replaced
     by `CONTRIBUTING.md` and `plugins/README.md`);
   - `docs/workflow/legacy/`: `env-vars.md` (the two-tenant environment
     model is gone; replaced by the configuration handbook at P0.4).
     Relative links into and out of moved files are repointed (path-only
     edits); the files themselves are not edited beyond that, the
     frontmatter and the banner. Their `tracks:` lists are left as they
     were: a legacy document tracks nothing.

### Frontmatter and banners

- Fully historical documents get `status: legacy` and, right after the
  frontmatter, the banner:
  `> **Legacy v4 document.** Kept for history; superseded by the v5 spec. Not maintained.`
  Applies to the four handbooks named by the pivot ADR and to everything
  in a `legacy/` folder.
- Other v4 handbooks (provider adapters, policy engine, provider risk
  models, threat-model synthesis) stay `status: current` because they
  still describe the code, and get the softer banner:
  `> **v4 document.** English rewrite scheduled by the v5 plan; `tracks` paths updated for the new layout.`
  Their `tracks:` paths are rewritten for the new layout; entries that
  pointed at deleted files (Supabase migrations, scripts) are removed.
- The ADRs listed under `supersedes` in the pivot ADR get
  `status: superseded`, `superseded-by: pivot-v4-to-v5-on-prem-mission-tokens`
  and `superseded-date: 2026-10-12`; those under `partially-supersedes` get
  `status: partially-superseded` and
  `partially-superseded-by: pivot-v4-to-v5-on-prem-mission-tokens`. This
  follows the hyphenated keys the repository already uses
  (`superseded-by`, `partially-supersedes`). Each also gets a one-line
  English banner after its frontmatter naming the superseding ADR.
- v4 ADRs that the pivot does not supersede keep their status; they
  remain in force until a later ADR supersedes them explicitly. Their
  bodies still cite v4 paths (`packages/web`, `packages/providers`); that
  is expected and is not drift.

### Indexes and tooling

- The README lists only non-legacy decisions (today: the pivot ADR and
  the layout ADR); the historical list lives in git and in
  `docs/decisions/`.
- `doc-audit` and `drift-detector` should skip any file under a `legacy/`
  folder and any document whose frontmatter says `status: legacy`. This
  is a follow-up for the skills (they live in the harness, not in this
  repository); until it lands, their reports on those files are noise.
- Nothing is translated and nothing is deleted. Rewrites are new English
  documents listed in the v5 plan (§6.2), written when the code they
  describe exists.

## Consequences

- Wikilinks such as `[[unified-tokens-delegation-chain-and-escalation-channel]]`
  keep resolving: ADRs did not move.
- Relative links to moved documents were updated in the current spec and
  in `gateway-risk-model.md`, and v4 paths (`packages/web`,
  `packages/providers`) were rewritten to the new layout in the four
  non-legacy spec files that cited them. These path-only edits are the
  sole changes made to `docs/spec/` by P0.1; the coding agent otherwise
  treats the spec as read-only.
- Readers landing on a v4 document see its status in the first lines.
- `tracks:` drift detection keeps working on the v4 handbooks that still
  describe live code, which matters because P0.5, P1.2 and later features
  rewrite exactly that code.
- The handbook of a subsystem can be `status: current` with a v4 banner
  while its rewrite is pending; the banner, not the status, tells the
  reader about the language and the planned rewrite.

## Rejected alternatives

- **Translate the v4 documents into English.** Costly, and it would give
  obsolete content the appearance of a maintained source. Rejected by the
  pivot amendment and confirmed here.
- **Delete the v4 documents.** Loses the reasoning behind choices v5
  inherits (prefix + slow-hash token lookup, AEAD blob layout, audit row
  shape, the risk model itself) and breaks every wikilink. Rejected.
- **Leave the v4 documents unmarked.** A contributor reading
  `docs/handbook/web-app.md` would implement against a SaaS that no
  longer exists. Rejected.
- **Move every v4 document into `legacy/` folders, ADRs included.**
  Uniform, but it breaks `[[wikilinks]]` (resolved by file name without
  a path) and the ADR immutability convention of "a decision stays where
  it was taken". Rejected for ADRs and for handbooks still tracking live
  code.
- **Add a new `v4` status value in every frontmatter.** Redundant with
  the banner and with the existing `superseded` vocabulary; one more
  value for the tooling to learn. Rejected.

## Amendment 2026-10-13 — the form of an amendment (Phase 2 cycle-end)

Adds to "Frontmatter and banners"; changes none of the decisions above.

### Context

The v5 ADRs are amended in place rather than superseded when a feature
refines them. By the end of Phase 2 the amendments sat in three different
places: between `## Consequences` and `## Rejected alternatives`, after
`## Rejected alternatives`, and as notes in the header, above `## Context`. A
header note is outside the four sections an ADR must have, and one of them
had grown into a decision with its reasons and no rejected alternative of its
own.

### Decision

An amendment written from now on is a section
`## Amendment <date> — <subject>` placed **after `## Rejected alternatives`**,
at the end of the document, with its own `### Context`, `### Decision`,
`### Consequences` and `### Rejected alternatives`. The header carries a
one-line pointer to it, and the decision it refines says so where it stands.
An amendment that only records "amended by ADR X" stays a header note with a
wikilink: the decision is in X.

### Consequences

- The four sections of the original ADR read as they were accepted; what
  changed since is below them, dated.
- The amendments written at the Phase 2 cycle-end follow the rule
  ([[plugin-contract-and-credential-spec]], streamed results;
  [[atomic-budget-accounting]], the agent label). The amendments written
  before it are left where they are.

### Rejected alternatives

- **Moving the existing amendments to the new place.** It rewrites accepted
  documents for their layout alone; none of them is malformed.
- **A new ADR for every refinement.** A reader of the amended decision would
  not learn that it changed; the cases that deserve their own ADR are
  written as one and linked from the header.
