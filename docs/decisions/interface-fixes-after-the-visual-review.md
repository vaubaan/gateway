---
title: Interface fixes after the visual review — the phone, the head of an approval, one date form
status: accepted
date: 2026-10-14
---

# Interface fixes after the visual review — the phone, the head of an approval, one date form

> The choices made while fixing what an independent visual review of the redesigned
> interface found (interface redesign, step R3). The frame is ADR
> [interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md);
> the pages are ADRs
> [now-and-waiting-pages](now-and-waiting-pages.md),
> [mission-pages-confirm-the-explicit-list-and-ask-before-a-key-stops](mission-pages-confirm-the-explicit-list-and-ask-before-a-key-stops.md)
> and
> [redesigned-pages-accounts-reference-activity-settings](redesigned-pages-accounts-reference-activity-settings.md).
> Handbooks: [web-app](../handbook/web-app.md), [requests](../handbook/requests.md),
> [audit](../handbook/audit.md), [connections](../handbook/connections.md),
> [plugin-sdk](../handbook/plugin-sdk.md).

## Context

The review walked every page as three people, at four widths and in both themes. On a
desktop the application is the mockup. It found three kinds of defects that a fix in
one page would not settle:

- **A phone.** At 390 px the navigation was seven icons with no word, tables wrapped
  word by word, the actions of a row existed only on hover, and one page scrolled
  sideways. The link an agent hands its human is often opened on a phone.
- **The head of an approval** was the catalog label of the permission ("Write on main
  / master / release-\* (direct commit OR PR merge)"). A person had to open the request
  and read five arguments to learn that an agent wanted to merge a pull request on
  `acme-org/app`.
- **Dates** came in three forms, one of them the browser's own
  ("10/14/2026, 1:48:59 AM"): a `toLocaleString` default, not a choice.

The rest — a sign-in that ended on a card, a form that lost what was typed, a dialog
taller than its window, raw ids in the detail of a change — is local, and is recorded
here where a choice was made.

## Decision

### 1. On a phone the navigation is a bar at the bottom, an icon and a word per entry

A finger has no tooltip: an icon alone says nothing. Under 641 px the seven entries
are drawn as a bar fixed at the bottom of the screen — **Now, Waiting, Missions,
Accounts** and **More**, which opens Activity, Reference and Settings in a sheet above
the bar. The entries stay seven and the same list; only its drawing changes
(`NavLinks`, `PHONE_BAR`). A label too long for a fifth of the screen is drawn short
("Waiting") and keeps its full name for assistive technology. The count of what waits
stays on its entry. Between 641 and 1023 px the rail of icons with a `title` stays as
it was: there a pointer exists.

Four entries and "More" is what 360 px holds with a 12 px word under each icon — the
smallest of the four text sizes; a fifth size was not added for the bar.

### 2. On a phone a table is rows of labelled lines, and nothing depends on hovering

`DataTable` draws each row as a block under 641 px: its first cell is the title, every
other cell a line with the name of its column before the value. The roles are written
out so that the table stays a table for assistive technology. The actions of a row are
always drawn in a phone-sized window, and on any device that cannot hover. This is
the default of the shared component, not a rule of two pages: a table added later is
readable on a phone without its author thinking of it. `narrow="scroll"` keeps a grid
for a table that needs one.

### 3. The head of an approval is composed from what the gateway already knows

The head is **what the tool does in a few words, then the resource the call resolves
to**: "Merge a pull request · acme-org/app". The permission, its severity and the
exact arguments stay right below, as they were.

- **The words are the plugin's, and optional.** `ProviderPlugin.toolTitles` maps a tool
  name to a short title ("Merge a pull request"). It is not a required contract: a
  tool without a title is headed by its name in mono, as the protocol spells it.
  Every tool of the plugins shipped with the gateway has one (a structural test), not
  only the tools a shipped preset gates: a person may set any permission to "ask me
  first".
- **Nothing is written per request and no argument is read.** The resource is the
  `resource_ref` the pipeline already wrote on the audit entry of the refused call;
  the request row gives the tool. The list of what waits still never opens the sealed
  arguments.
- **`tools/list` is unchanged.** The title is a field of the plugin beside its tools,
  not a property of `McpToolDeclaration`: what an MCP client lists and what an agent
  reads does not move with a change made for people.
- **A teammate reads the same head.** The open requests of a mission's session view
  now carry the tool and the resource of an approval. Both are on the refused call's
  line of the activity a teammate may already read; the fingerprint of the arguments
  and the arguments stay out, as decided in
  [audit-visibility-members-and-operators](audit-visibility-members-and-operators.md).

Who asks is said agent first, then whose key it holds: "release-bot, with your key",
never "You · release-bot", which read as if the person were the one asking.

### 4. One form for a date, written by one helper, whatever the browser's locale

`lib/dates` is the one place a date becomes text: "14 Oct" (with the year when it is
not this one), "01:48" on 24 hours (with seconds in a record), "14 Oct, 01:48". No page
hands a date to `toLocaleString`. The locale never changes the text; the time zone
does — the server writes UTC and the browser replaces it with the reader's own after
hydration, as before. A test reads the sources and fails on a locale-dependent call.

The day comes before the clock in a sentence ("valid until 14 Oct, 01:58"); the
activity record keeps its column of clock times with the day under each.

### 5. Smaller choices

- **Sign-in lands on the home.** `/login` sends a signed-in person to "Now" and the
  sign-in it starts returns there. The card "You are signed in" is kept for a failed
  attempt while a session exists and for the install session, which has no home.
- **A refused form comes back as typed, never with a secret.** The name and the
  non-secret values travel with the one-time notice; a field declared `secret` is
  left out whatever it held, and its field says so ("A secret is never kept: type it
  again").
- **A dialog is never taller than its window**: the shared `Dialog` takes its top
  margin and the same room under it off its height and scrolls its body. The height
  rule the Give-access dialog had for its own list is removed.
- **A change of the record is read in words first**, the stored JSON one click away.
  The lines are derived from the keys a record holds, not written per act.
- **The quiet ink on a tint is the second ink.** A tinted surface redefines `--ink-3`
  as `--ink-2` for what it holds; no component needs to know where it is drawn.
- **The interface reference is listed for administrators only**; the page stays
  reachable by its address for anyone signed in.
- **A limit is not editable after creation, and the page says so**: "for another limit
  from now on, duplicate the mission" — with the link — instead of "edit the mission".
  Whether limits become editable in place is the owner's decision, not this one.

## Consequences

- A plugin author is asked for one more thing, optional and checked by `definePlugin`
  when given: a few words per tool. The contributor guide says why. A plugin that
  gives none still works; its approvals are headed by tool names.
- `SessionOpenRequest` gains `tool` and `resource_ref`, and `RequestSummary` gains
  `call`. Each approval request listed costs one indexed audit read
  (`latestCall`), as the request page already paid.
- Every `DataTable` changes its drawing under 641 px. The preset comparison of the
  reference is a plain table and keeps its grid, scrolling inside its own box.
- A date reads the same on every browser. A reader in a US locale no longer sees the
  12-hour clock they may expect; the interface is in English with one international
  form, like its numbers.
- The style guide (spec) still says that on a phone the navigation "becomes a bar above
  the page" and that whole pages were not designed for a phone. The code now goes
  further than that sentence; the spec is the planning agent's to bring in line.

## Rejected alternatives

- **A label under each of seven icons in the top bar.** Seven labels in 390 px are 55 px
  each: "Waiting for you" and "Reference" do not fit at any size the type scale has.
- **A menu button ("hamburger") hiding the whole navigation.** One more press for the
  two places a person opens on a phone — what waits, and their missions — and the count
  of what waits would be hidden behind it.
- **A sentence template per tool, filled with the arguments** ("Merge pull request
  #128 into main on acme-org/app"), as the mockup draws it. It reads best, and it makes
  every plugin author write prose that must stay true to an argument schema, turns
  argument values — which may be anything an agent sends — into the largest text of the
  page, and would have the list of what waits open the sealed arguments. The title and
  the resource say what and where; the arguments are one block below, each by its name,
  exactly as sent.
- **A required title for every tool.** A plugin that omits it would stop loading for a
  reason that changes nothing for an agent.
- **`title` on the tool declaration** (the MCP specification has such a field). It
  would appear in `tools/list` for every client at once; the protocol surface is not
  this work's to change.
- **Deriving a title from the tool name** (`merge_pull_request` → "Merge pull
  request"). Wrong often enough to mislead (`upstash_redis__del`, `railway__get-status`,
  `supabase__generate_link`), on the one line a person decides from.
- **The browser's locale with a fixed `en-GB`.** One form, but through an API that
  still varies by engine (a comma here, "Sept" there) and cannot be asserted to the
  character on the server and in the browser alike.
- **Horizontal scroll for every table on a phone.** The row actions and the last
  columns would sit off-screen with nothing saying they exist.
- **Keeping a typed secret through the redirect** (in the notice, encrypted or not).
  A key would exist in a session store for five minutes for the sake of one field.
