---
title: A catalog's fallback risk is an explicit flag, touched only when no other entry matched, and in no catalog macro-action
status: accepted
date: 2026-10-13
---

# A catalog's fallback risk is an explicit flag, touched only when no other entry matched, and in no catalog macro-action

## Context

Every catalog declares a fallback, `<provider>.uncategorized-write`, matching every write, so that
its appearance signals a missing catalog entry. Evaluated like any entry, it was touched by every
write in addition to its dedicated entry: a mission accepting `github.merge-protected` but not the
fallback was refused, plugins put the fallback in every write bundle, and accepting it came to mean
"any write at all".

## Decision

A slice touches the fallback only when no other entry matched it; dedicated entries that overlap
still co-fire. The fallback is the entry flagged `fallback: true`, exactly one per catalog, named
`<provider>.uncategorized-*`, and a catalog macro-action listing it is a loader error; a creator may
still accept it by hand, or tick the gateway's own "Anything else".

## Consequences

- The fallback's presence in the audit again means "a catalog entry is missing";
  `assertCatalogCoverage` reports the samples only it covers.
- First-party catalogs must carry the flag (`assertPluginWellFormed`); a third-party catalog
  without it is detected by convention and warned about.
- One special case in the evaluator that the YAML does not show: the plugin-sdk handbook says it.

## Rejected alternatives

### Put the fallback in every write macro-action

Turns the fallback into an "allow writes" switch and empties its audit signal.

### Drop the fallback entirely

The explicit opt-in for uncategorized writes is useful and the spec requires it.

### Detect the fallback by pattern only

Misses GitHub's `github.repo[**].W`; the flag is authoritative.
