---
title: The Activity list grows through its address, rendered by the server
status: accepted
date: 2026-10-23
---

# The Activity list grows through its address, rendered by the server

> Handbook: [audit](../handbook/audit.md) ("Paging: the list grows as you scroll").

## Context

The Activity page (`/activity`) showed one page of 50 lines of the record and
offered the older ones through a small "Earlier" link inside the hint under
the table, which nobody saw. The product owner asked for the next lines to be
loaded as the reader scrolls (2026-10-23).

The page is a server component: each row is rendered on the server from an
`AuditEntryView`, with the risk catalog (`riskExplainer`), the change names of
the open line and the reader's identity at hand; the detail of a line has an
address (`?open=<id>`), as does a position in the record (`?cursor=`). Who
reads what is decided by `AuditQueryService.search(principal, …)`, before
filters and paging (ADR
[audit-visibility-members-and-operators](audit-visibility-members-and-operators.md)).
There was no infinite list or "load more" pattern in the application to reuse.

## Decision

1. **The number of lines shown is part of the address**: `?lines=<n>`, whole
   pages of `AUDIT_PAGE_SIZE`, one page by default (`activity/lines.ts`).
2. **The server renders the whole list** in one search,
   `search(principal, filters, cursor, lines)`: the same scope, the same
   filters, the same position, a longer page. No endpoint, server action or
   serialized row format is added; nothing but the page's render reads the
   record.
3. **One small client part**, `LoadEarlier`: a "Load earlier" link to the same
   address with one page more, and an `IntersectionObserver` sentinel that
   follows it with `router.replace(href, { scroll: false })`. Rows are keyed
   by entry id, so the rows already shown keep their place and state, and the
   next page appears under them. Without JavaScript the link is a link.
4. **Every link that keeps the position keeps `lines`**: opening or closing a
   line's detail keeps the lines loaded, and loading more keeps the open line
   open. Changing a filter, the period, "Clear" and "Newest" start again from
   one page.
5. **A ceiling of 20 pages (1,000 lines) per address.** Past it the page offers
   "Continue with earlier lines", a fresh list from `?cursor=`.

## Consequences

- The authorization of the next pages is the first page's, by construction.
- Each step re-reads and re-renders every line loaded so far (O(n) per step,
  bounded by the ceiling); the keyset query is indexed and the rows are
  plain, which keeps a step at 1,000 lines well within a page render.
- A reload, a shared link or the detail of a line renders the same lines; new
  entries written meanwhile appear on top when the list starts at the newest.
- The address is replaced, not pushed: Back leaves the page instead of
  unloading pages one by one.
- The client part is generic (an address and an observer); another server
  list can grow the same way.

## Rejected alternatives

- **A server action or a route handler returning the next page** to a client
  list. The rows would have to be rendered on both sides (a shared component
  fed with the catalog labels and the names) or the action would return
  rendered elements; either way a second entry point to the record that must
  repeat the principal's scope, and loaded pages that the detail link
  (`?open=`, a navigation) would lose unless the list moved to client state.
- **Cursor pages kept in client state** (append the result of each
  `?cursor=` page): the same loss on navigation, and no address for what is
  shown.
- **Several cursors in the address** (`?through=<last cursor>`): the same
  render with a longer, opaque address; a line count reads better and needs
  one query instead of one per page.
- **No ceiling**: one address could ask the store and the renderer for the
  whole retention period.
