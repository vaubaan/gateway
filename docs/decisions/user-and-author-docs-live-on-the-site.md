---
title: User and plugin-author docs live on the site; the repository keeps contributor docs and links out
status: accepted
date: 2026-11-20
author: Renaud Pelissier (product owner), drafted with Claude
---

# User and plugin-author docs live on the site; the repository keeps contributor docs and links out

## Context

Operator procedures were written twice, in `deploy/*.md` and on the site, and each copy drifted:
three site pages still taught a master-key step the instance no longer needs. Plugin authors had
two tracks, an in-repo guide tied to monorepo paths and the published kit's skills. Deployed
instances link to site doc paths and anchors, and the site already generates its references from
the repository.

## Decision

A procedure for people who install, run or use an instance, or who write a plugin with the
published kit, has one home: a page of the site. The repository keeps the spec, ADRs, handbooks,
test plans and workflow for contributors, plus image internals, and links to the site for any
procedure; a fact the site shows and the repository owns is generated from it, never copied.

## Consequences

- A repository file that restates a site procedure is cut to a link when next touched.
- A site page linked from the gateway's interface keeps its path and heading anchors; a move leaves
  a permanent redirect and a test.
- The author guide uses only the published kit and catalog, so `plugins/` may leave this repository
  without breaking it.
- Reshaping a repository doc the site parses (configuration keys, threat model, known limitations)
  is checked against the site build in the same change.

## Rejected alternatives

### Procedures in the repository, the site rendering them

Repository Markdown cannot hold the site's redirects, twins and stable anchors, and contributors'
docs would be mixed with users' in one tree.

### Two copies kept in step by review

Tried in practice: the copies drifted within weeks.
