---
title: Web app — route map, layouts, shell, design system
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/app/layout.tsx
  - apps/gateway/src/app/(app)/page.tsx
  - apps/gateway/src/app/(public)/layout.tsx
  - apps/gateway/src/app/(app)/layout.tsx
  - apps/gateway/src/app/admin/(guarded)/layout.tsx
  - apps/gateway/src/app/globals.css
  - apps/gateway/src/app/icon.svg
  - apps/gateway/src/app/apple-icon.png
  - apps/gateway/src/styles/tokens.css
  - apps/gateway/src/components/ui/
  - apps/gateway/src/components/shell/
  - apps/gateway/src/lib/vocabulary.ts
  - apps/gateway/src/lib/theme.ts
  - apps/gateway/src/lib/theme-server.ts
  - apps/gateway/src/app/(app)/design/
  - apps/gateway/src/app/(app)/settings/
  - apps/gateway/src/app/(app)/delegations/layout.tsx
  - apps/gateway/src/components/LocalDate.tsx
  - apps/gateway/src/components/auth/NeedsUser.tsx
  - apps/gateway/src/components/auth/PrincipalCard.tsx
  - apps/gateway/src/components/auth/principal.ts
  - apps/gateway/src/components/connections/
  - apps/gateway/src/components/risk/
  - apps/gateway/src/server/providers/
  - apps/gateway/src/server/oauth-as/pages.ts
  - apps/gateway/src/app/admin/bootstrap/page.tsx
  - apps/gateway/src/app/(app)/reference/
  - apps/gateway/src/components/telemetry/ValidationBadge.tsx
  - apps/gateway/src/app/(app)/missions/message-of.ts
  - apps/gateway/src/app/(app)/missions/state-badge.tsx
  - apps/gateway/src/lib/auth/session.ts
  - apps/gateway/src/lib/connections/session.ts
  - apps/gateway/next.config.ts
  - apps/gateway/tests/unit/app/
---

# Web app — route map, layouts, shell, design system

The frame of the human surface of the instance (spec
[vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2): which route is served by
which file, which handbook owns it, and what every page shares — root layout,
the shell with its side navigation, the words, the themes, the tokens and the
components of the design system. The behaviour of each page is in the handbook
of its feature. The look and the rules a screen must follow are in the spec
[style-guide](../spec/style-guide.md). The v4 text that used to live here (Supabase sign-in,
organisations, sidebar) is kept in [legacy/web-app.md](legacy/web-app.md); none
of that code exists any more.

## What the app is

`apps/gateway` is one Next.js application (`next` 16.4.0, `react` 19.3.0, App
Router) built as a standalone server (`output: 'standalone'`,
[configuration](configuration.md)). It serves the pages, the JSON and form
endpoints behind them, and the agent-facing MCP door from the same process.

- **Pages are server components.** They read the session and the data through
  the composition root (`getRoot()`, reached through a session helper of
  `lib/auth/session.ts`, see [Session helpers](#session-helpers--libauthsessionts)),
  are all `dynamic = 'force-dynamic'`, and render HTML. No page loads its data
  from the browser.
- **Client components are the exception** (`'use client'`): the mission
  creation form with its preset panel and its Custom editor, the mission actions, the gate control
  of the mission page (`GateControl`), its "Members and tokens" section (`TeamSection`), the bootstrap kit view, the share form
  (`ShareForm`), `RevokeConnection`, `LocalDate`, the body of
  a service's reference (`ProviderView` and its sections), the gallery of
  `/design`, the parts of the shell that need the browser (`NavLinks`,
  `UserMenu`, `ThemeToggle`) and the components of the design system that hold
  state or read the path (marked "client" in
  [The design system](#the-design-system--componentsui)). The only
  `fetch` calls from the browser are the mission form (`POST /api/missions`,
  `POST /api/missions/preview`), the mission actions
  (`POST /api/missions/<id>/rotate|revoke`), the gate control
  (`POST /api/missions/<id>/gate`) and the "Members and tokens" section of the
  mission page (`POST /api/missions/<id>/members`, `…/members/<userId>/remove`,
  `…/tokens`, `…/tokens/mine`, `…/tokens/<tokenId>/revoke`).
- **Everything that decides lives under `src/server/`**, host-agnostic (it
  never imports `next`). A `route.ts` is a one-line adapter:
  `(await getRoot()).<module>.handlers.<name>(request, …)`. Three routes have
  another shape: `healthz/route.ts` (`healthHandler(() => getRoot())`),
  `.well-known/oauth-protected-resource/route.ts`
  (`oauth.discovery.executionResource(request)`) and
  `agent-bootstrap.md/route.ts`, which reads no root and serves the
  `content.md` next to it (the only `force-static` route).
- **There is no `middleware.ts`** (and no `proxy.ts`): nothing runs in front of
  the routes, each page and each handler authenticates itself.

## Route map

| Route                                                                                                                       | File under `apps/gateway/src/app/`                                                                            | Handbook                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/`                                                                                                                         | `(app)/page.tsx`                                                                                              | this handbook: the one home; until the "Now" page lands, the missions list                   |
| `/settings`, `/design`                                                                                                      | `(app)/settings/page.tsx`, `(app)/design/**`                                                                  | this handbook, [The shell](#the-shell--componentsshell), [The gallery](#the-gallery--design) |
| `/login`                                                                                                                    | `(public)/login/page.tsx`, `(public)/layout.tsx`                                                              | [authentication](authentication.md)                                                          |
| `GET /auth/login`, `GET /auth/callback`                                                                                     | `auth/login/route.ts`, `auth/callback/route.ts`                                                               | [authentication](authentication.md)                                                          |
| `POST /logout`                                                                                                              | `logout/route.ts`                                                                                             | [authentication](authentication.md)                                                          |
| `/admin/bootstrap`, `POST /api/auth/bootstrap`                                                                              | `admin/bootstrap/page.tsx`, `api/auth/bootstrap/route.ts`                                                     | [authentication](authentication.md)                                                          |
| `/admin`, `/admin/identity-provider`                                                                                        | `admin/(guarded)/page.tsx`, `admin/(guarded)/identity-provider/page.tsx`, `admin/(guarded)/layout.tsx`        | [authentication](authentication.md)                                                          |
| `POST /api/admin/identity-provider`                                                                                         | `api/admin/identity-provider/route.ts`                                                                        | [authentication](authentication.md)                                                          |
| `/admin/provider-apps`, `POST /admin/provider-apps/<provider>`                                                              | `admin/(guarded)/provider-apps/**`                                                                            | [connections](connections.md)                                                                |
| `/admin/telemetry`, `POST /api/admin/telemetry`                                                                             | `admin/(guarded)/telemetry/page.tsx`, `api/admin/telemetry/route.ts`                                          | [telemetry](telemetry.md)                                                                    |
| `/accounts`, `/accounts/new`, `/accounts/new/<provider>`, `/accounts/<id>`                                                  | `(app)/accounts/**/page.tsx`                                                                                  | [connections](connections.md)                                                                |
| `/accounts/<id>/share`, `POST /accounts/<id>/shares`, `…/shares/<id>/revoke`, `…/transfer`                                  | `(app)/accounts/[id]/share/`, `shares/`, `transfer/`                                                          | [authority](authority.md)                                                                    |
| `/shares`                                                                                                                   | `(app)/shares/page.tsx`                                                                                       | [authority](authority.md)                                                                    |
| `/admin/users`, `POST /admin/users/<id>/deactivate`, `…/<id>/reactivate`                                                    | `admin/(guarded)/users/**`                                                                                    | [authentication](authentication.md)                                                          |
| `/admin/groups`, `POST /admin/groups/create`, `…/<id>/members[/<userId>/remove]`                                            | `admin/(guarded)/groups/**`                                                                                   | [authority](authority.md)                                                                    |
| `/admin/connections`, `POST /admin/connections/<id>/reassign`                                                               | `admin/(guarded)/connections/**`                                                                              | [authority](authority.md)                                                                    |
| `POST /accounts/connect/<provider>`, `GET /connections/callback/<provider>`                                                 | `(app)/accounts/connect/`, `(app)/connections/callback/`                                                      | [connections](connections.md)                                                                |
| `POST /accounts/<id>/discover`, `/revoke`, `/resources/<resourceId>`                                                        | `(app)/accounts/[id]/**/route.ts`                                                                             | [connections](connections.md)                                                                |
| `/missions`, `/missions/new`, `/missions/<id>`                                                                              | `(app)/missions/page.tsx`, `(app)/missions/new/page.tsx`, `(app)/missions/[id]/page.tsx`                      | [missions](missions.md)                                                                      |
| `POST /api/missions`, `/api/missions/preview`, `/api/missions/<id>/rotate`, `/revoke`, `/gate`, `/members/**`, `/tokens/**` | `api/missions/**/route.ts`                                                                                    | [missions](missions.md)                                                                      |
| `GET /agent-bootstrap.md`                                                                                                   | `agent-bootstrap.md/route.ts`                                                                                 | [missions](missions.md)                                                                      |
| `/missions/<id>/session`                                                                                                    | `(app)/missions/[id]/session/page.tsx`                                                                        | [audit](audit.md)                                                                            |
| `/activity`                                                                                                                 | `(app)/activity/page.tsx`                                                                                     | [audit](audit.md)                                                                            |
| `/reference`, `/reference/<id>`                                                                                             | `(app)/reference/page.tsx`, `(app)/reference/[id]/page.tsx`                                                   | this handbook, [The provider reference](#the-provider-reference--reference)                  |
| `/waiting`, `/waiting/<id>`                                                                                                 | `(app)/waiting/**/page.tsx`                                                                                   | [requests](requests.md)                                                                      |
| `GET /r/<id>`                                                                                                               | `r/[id]/route.ts`                                                                                             | [requests](requests.md)                                                                      |
| `GET /api/requests`, `POST /api/requests/<id>/decide`                                                                       | `api/requests/**/route.ts`                                                                                    | [requests](requests.md)                                                                      |
| `GET, POST, DELETE /mcp`, `GET /mcp/catalog`                                                                                | `mcp/route.ts`, `mcp/catalog/route.ts`                                                                        | [execution-door](execution-door.md)                                                          |
| `GET /.well-known/oauth-protected-resource`                                                                                 | `.well-known/oauth-protected-resource/route.ts`                                                               | [execution-door](execution-door.md)                                                          |
| `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource/mcp/manage`                       | `.well-known/oauth-authorization-server/route.ts`, `.well-known/oauth-protected-resource/mcp/manage/route.ts` | [management-door](management-door.md)                                                        |
| `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/authorize/decision`, `POST /oauth/token`, `POST /oauth/revoke` | `oauth/**/route.ts`                                                                                           | [management-door](management-door.md)                                                        |
| `GET, POST, DELETE /mcp/manage`                                                                                             | `mcp/manage/route.ts`                                                                                         | [management-door](management-door.md)                                                        |
| `/delegations`, `POST /delegations/<id>/revoke`                                                                             | `(app)/delegations/**`                                                                                        | [management-door](management-door.md)                                                        |
| `/admin/oauth-clients`, `POST /admin/oauth-clients/<id>`                                                                    | `admin/(guarded)/oauth-clients/**`                                                                            | [management-door](management-door.md)                                                        |
| `GET /healthz`                                                                                                              | `healthz/route.ts`                                                                                            | [configuration](configuration.md)                                                            |

`/` is the one home of a signed-in person (`(app)/page.tsx`: `currentUser()`,
then the missions list until the "Now" page lands); a visitor without a
session is sent to `/login`. Every path the interface had before its words
changed answers with a permanent redirect
([Routes follow the words](#routes-follow-the-words--nextconfigts)).

The table names the method a caller uses. The three `.well-known` routes also
export `HEAD` and `OPTIONS`, and `POST /oauth/register`, `/oauth/token` and
`/oauth/revoke` also export `OPTIONS`, on the same handler
([management-door](management-door.md)). A segment that holds only a
`route.ts` has no page: `/accounts/<id>/shares`, `/accounts/connect/…`,
`/delegations/<id>/revoke` and the `admin/(guarded)` mutations answer `POST`
only.

## Layouts

- **Root — `app/layout.tsx`.** `<html lang="en">` with the Geist Sans and Geist
  Mono font variables (`geist` package), the page `metadata` and `globals.css`.
  It reads no session; it reads the theme of the request (`currentTheme()`,
  [Themes](#themes--libthemets-libtheme-serverts)) and writes it as
  `data-theme` on `<html>`, or writes nothing for "follow the system".
- **`globals.css`** imports `src/styles/tokens.css` (the design tokens,
  [below](#tokens--stylestokenscss)) and sets the base element styles: body
  text at 14 px on the paper colour, three headings, links, the focus ring,
  `code`, the `prefers-reduced-motion` rule, the `.vbn-sr-only` utility and one
  layout class, `.vbn-container`, the column of a page **outside** the shell
  (sign-in, bootstrap). The root font size is the browser's: the 125 % of the
  first interface is gone.
- **Icons.** `app/icon.svg` and `app/apple-icon.png` are picked up by the Next
  file convention.
- **`(public)/layout.tsx`** — the pages reachable without a session (`/login`):
  the page inside a `Container`, then the build footer.
- **`(app)/layout.tsx`** — the human surface: `currentPrincipal()`; no
  principal → `redirect('/login')`; otherwise
  `<AppShell principal instance>`, `instance` being the host of the public URL.
- **`(app)/delegations/layout.tsx`** — connected apps are part of Settings: the
  page inside `SettingsFrame` (the local navigation of Settings).
- **`admin/(guarded)/layout.tsx`** — `adminDecision()`; no session → the
  admin sign-in; an administrator → `<AdminShell principal instance>`, the
  application shell with the local navigation of Settings
  ([The shell](#the-shell--componentsshell)); a signed-in person who is not one
  → the "Not an operator" explanation in a `Container`, followed by the build
  footer and no navigation. Rules in [authentication](authentication.md).
  `/admin/bootstrap` is outside it.

A layout is navigation, never the authorization boundary: the App Router can
render a page segment without its layout. Every page and every route
authenticates itself (next section).

## Routes follow the words — `next.config.ts`

The pages are served under the words a person reads (`/accounts`, `/waiting`,
`/activity`, `/reference`, `/settings`), and the server builds its redirects
from the same constants: `CONNECTIONS_PATH` (`server/connections/service.ts`)
is `/accounts`, `INBOX_PATH` (`server/requests/url.ts`) is `/waiting`,
`PROVIDERS_PATH` (`server/providers/links.ts`) is `/reference`. The directories
under `(app)/` carry the same names; the modules under `src/server/` keep the
protocol's (`connections`, `requests`, `audit`, `providers`).

`LEGACY_REDIRECTS` in `next.config.ts` is the list of the paths the interface
had before (`/accounts`, `/accounts/<anything but callback>/**`,
`/waiting/**`, `/activity`, `/reference/**`); `redirects()` answers each with a
permanent redirect. Next sends 308: a form post keeps its method and its body,
and the query string is carried over. A redirect is answered before any page
or route is looked up.

Three kinds of path are never redirected, because they are part of a protocol:

- `/connections/callback/<provider>` (`CONNECT_CALLBACK_PATH`): the callback a
  company registered at a provider. Its route file stays at
  `(app)/connections/callback/[provider]/route.ts`, alone in that directory,
  and the first-segment pattern of the redirect excludes `callback`;
- `/r/<id>`, the URL a refusal hands an agent: its handler redirects the
  creator to `/waiting/<id>` through `inboxRequestPath`;
- `/mcp/**`, `/api/**`, `/oauth/**`, `/auth/**`, `/.well-known/**`.

`/shares` and `/delegations` keep their paths until their pages are redesigned;
neither has a navigation entry: the first is linked from Accounts, the second
is in the local navigation of Settings.

## Session helpers — `lib/auth/session.ts`

Server components learn who is behind the request through one of these. They
add `headers()` and Next's navigation to the authenticator of `src/server/auth`;
authority is recomputed on every request.

| Helper               | For                                                                  | No session                    | Bootstrap operator                        | Signed-in user                              |
| -------------------- | -------------------------------------------------------------------- | ----------------------------- | ----------------------------------------- | ------------------------------------------- |
| `currentPrincipal()` | pages open to anyone (`/`, `/login`, `/admin/bootstrap`), layouts    | `principal: null`             | the principal                             | the principal                               |
| `requirePrincipal()` | an `(app)` page open to every session (`/activity`, `/reference/**`) | `redirect('/login')`          | the principal                             | the principal                               |
| `currentUser()`      | an `(app)` page that needs an identified user                        | `redirect('/login')`          | `null` → the page renders `<NeedsUser />` | `{ root, principal, user }`                 |
| `requireOperator()`  | every page under `admin/(guarded)`                                   | redirect to the admin sign-in | the principal while the token is active   | the principal if operator, else "not found" |

- `currentUser()` is the single answer to "the bootstrap operator opened a page
  that needs a user": Missions, the mission session, Connections (the share
  page included), Shares received, Requests and Delegations all render
  `NeedsUser` (`components/auth/NeedsUser.tsx`), one warning banner
  that says the bootstrap token owns no mission, connection or request and
  links to Administration → Identity provider. No page redirects the bootstrap
  operator elsewhere.
- `currentActor()` (`lib/connections/session.ts`) is `currentUser()` plus the
  `Actor` (`{ user, groups }`) the connection service expects; the Connections,
  share and Shares received pages use it. The same file holds `firstParam`,
  `PageSearchParams` and `takeNotice`.
- `adminDecision()` is the undecorated answer behind `requireOperator()`
  (`{ root, decision }`): the `admin/(guarded)` layout uses it to render the
  shell or the "Not an operator" explanation without redirecting.
- A `route.ts` under `(app)` calls no helper: it delegates to a handler of its
  module — `src/server/connections/handlers.ts` (connect, callback, discover,
  revoke, resource edit, transfer), `src/server/shares/handlers.ts` (share,
  revoke a share) or `src/server/oauth-as/handlers.ts` (`revokeDelegation`) —
  which checks the origin, then the session, then that the principal is a user
  (the provider callback, a top-level GET, checks the session and the
  single-use `state`).

## The shell — `components/shell/`

`AppShell({ principal, instance, children })` (server component,
`AppShell.tsx`) is the frame of every page a signed-in person sees: a side
navigation, then the page. `AdminShell` is the same shell with the local
navigation of Settings beside the page — one navigation, one person control
and one footer for the whole product.

```
<ToastProvider>
  <div.app>
    <a.skip href="#main">           "Skip to the page", shown on focus
    <aside.side>
      <Link.brand href="/">         the mark, "Vaubaan", the host of the gateway
      <nav aria-label="Main">       NavLinks: a <ul> of seven entries
      <div.foot>                    UserMenu, ThemeToggle
    <div.main>
      <main#main.page>              the page column
      <BuildFooter>
```

**The side navigation.** Seven entries, from `NAV_ORDER` and `NAV`
(`lib/vocabulary.ts`): **Now** (`/`), **Waiting for you** (`/waiting`),
**Missions**, **Accounts**, **Activity**, **Reference**, then **Settings**
after a hairline. Every principal sees the seven. A feature adds no entry:
seven is the budget (style guide §1).

- `NavLinks` (client, `usePathname`) renders them from `NavItem`s
  (`{ key, href, label, count?, ruleBefore? }`) with the icon of each entry
  (`Icon`). The current entry carries `aria-current="page"`, a fill and the
  strong weight.
- **Which entry is current** is `sectionOf(pathname)` (`nav.ts`, pure): the
  home is its own path only; any other entry is its path and what is under
  it; and the pages that have no entry belong to one — `/shares` to Accounts,
  `/delegations`, `/admin/**` and `/design` to Settings. Outside the
  application (`/login`) it is `null`.
- **The count** of "Waiting for you" is `OpenRequestCount` (server component):
  the number of open requests awaiting the signed-in person as creator, in
  amber, nothing at zero and nothing for the bootstrap operator
  ([requests](requests.md)). `data-testid="open-request-count"`.
- **The brand** leads to `/`, the one home. Under the name it prints
  `instance`, the host of the public URL. There is no health line and no
  version string in the navigation.

**The person and the theme**, at the foot:

- `UserMenu` (client): one button with the person's mark (`Avatar`), their
  name and their email (`personOf(principal)`: the display name when the
  identity provider gave one, else the email; "Bootstrap token" for the
  bootstrap operator). Long values are cut with an ellipsis and whole in the
  `title` and the `aria-label` ("Account: …"). It opens a small panel upwards —
  one of the few surfaces with a shadow — holding `RoleMark` ("administrator",
  or "installing this gateway" for the bootstrap operator; nothing for anyone
  else) and `SignOutButton` (a plain `POST /logout` form). Escape or a click
  outside closes it; Escape gives the focus back to the button.
  `data-testid="user-menu"`.
- `ThemeToggle` (client): one icon button showing the current choice; a press
  moves to the next of System, Light, Dark. `data-testid="theme-toggle"`.

**The collapsed form** is CSS only (`shell.module.css`). Under 1024 px the
navigation is a 56 px rail of icons: the labels and the person's name are
visually hidden, still read by assistive technology, and each link carries its
label as `title`. Under 641 px it becomes a bar above the page, and the theme
toggle is hidden (the choice is in Settings).

**The page column.** `main.page` is 1120 px wide at most, with 44 px of side
padding. A page chooses another measure through its `PageHeader`
(`width="narrow"` 860 px, `width="wide"` 1240 px), which the shell reads with
`:has([data-page-width])`. A page written before the redesign that holds a
wide table asks for the wide measure from its own style sheet
(`main:has(.wide)` in `activity.module.css`).

**Settings.** `settingsNav(administrator)` (`settings-nav.ts`, pure) gives the
groups of the local navigation: **You** — Preferences (`/settings`), Connected
apps (`/delegations`) — and, for an administrator
(`isOperatorPrincipal(principal)`, `components/auth/principal.ts`),
**Administration** — Setup (`/admin`), Sign-in (`/admin/identity-provider`),
Company apps (`/admin/provider-apps`), People (`/admin/users`), Teams
(`/admin/groups`), Accounts without owner (`/admin/connections`), Telemetry,
Registered apps (`/admin/oauth-clients`), in the order a gateway is set up.
No label is used for two things. `SettingsFrame({ principal, children })`
renders it beside its children (`SubNavFrame` + `SubNav`); the
`admin/(guarded)` layout (through `AdminShell`), the `delegations` layout and
the Settings page use it. Until the settings pages are redesigned, the
entries lead to the pages that exist, under their earlier titles.

`/settings` (`(app)/settings/page.tsx`, `requirePrincipal()`) holds the theme
as three named options (`ThemeChoiceControl`, `data-testid="settings-theme"`),
a link to connected apps and to the interface reference, and for an
administrator a link to Administration.

`BuildFooter` (server component) is one quiet line where the page ends:
`Vaubaan Gateway <version> · <commit>`, the build stamps of
`server/config/build-info.ts` — the values `/healthz` answers and telemetry
reports as `gateway_version`; `dev` for an unstamped build. Every page a human
reads carries it:

- the shell, for the application and for Administration, and the "Not an
  operator" explanation of the Administration layout;
- the public layout (`/login`);
- `/admin/bootstrap`, which is outside every layout and renders the footer
  itself (`admin/bootstrap/page.tsx`);
- the pages of the authorization endpoint — the consent screen and its
  message pages. They are HTML documents built as strings by
  `server/oauth-as/pages.ts`, not React, with their own minimal styles (they
  do not read the tokens): `buildFooter(build)` there writes the same line
  with the same test ids ([management-door](management-door.md)).

`data-testid`: `build-footer`, `gateway-version`, `gateway-commit`. The
version has one source, the root `package.json`
([coding workflow, "One version"](../workflow/coding-workflow.md#one-version)).

Seeing a link is not the authorisation. Each page decides for its principal
with a session helper: the Accounts, Shared with you, Missions, Waiting for
you and Connected apps pages render `NeedsUser` for the bootstrap operator
(`currentUser()`); `/activity`, `/reference/**`, `/settings` and `/design` are
open to every session (`requirePrincipal()`), and `/activity` widens what it
shows for an administrator.

## Words — `lib/vocabulary.ts`

The words a person reads are in one file, pure and browser-safe, imported by
the shell, the components and the pages (ADR
[interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md)).
The protocol keeps its names; this file is the bridge, keyed by them.

| Export                                                                  | Holds                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ROUTES`, `NAV`, `NAV_ORDER`, `NavKey`                                  | the page paths and the seven entries, in order                                                                          |
| `TERMS`, `count(n, term)`, `formatNumber`, `capitalize`                 | one word per thing, keyed by the spec's name (`TERMS.connection.one` is "account"); "26 permissions", "1,212 calls"     |
| `PAGES`, `ACTIONS`, `SECTIONS`                                          | page titles and their one-sentence ledes; the labels of actions ("Replace key", "Give access"); shared section headings |
| `GATE_WORDS`, `gateWordOf(gate)`, `ALLOW_WORDS`, `asksFirst(name)`      | "runs freely", "ask me first", "not included"; "Can", "Asks you first" / "Asks Alice first", "Cannot", "Limits today"   |
| `SEVERITY_LABEL`, `WHY_LABELS`, `WHY_ORDER`, `whyValue(axis, v)`        | the six axes of the risk model in words (Undo, Blast radius, Data, Cost, Visible to, Lasts) and their values            |
| `LIMIT_WORDS`, `usage`, `roomLeft`, `perPeriod`, `limitsReset`          | "1,860 / 3,000", "49 of 50 left today", "3,000 a day", "limits reset every day"                                         |
| `KEY_WORDS`, `keyOf(holder)`, `possessive`                              | "your key", "Carol’s key", "the machine key nightly"                                                                    |
| `ROLE_WORDS`, `qualifiers`, `ownership`, `accessGiven`, `mayAllow`      | "· you · creator", "you own it with Platform", "access given by Bob · 12 of 17", "all 15"                               |
| `MISSION_STATES`, `ACCOUNT_STATES`, `REQUEST_STATES`, `DECISION_WORDS`  | a label and a tone per state, keyed by the protocol's state; the tone is `null` for the normal state                    |
| `WAITING`, `waitingFor(name)`, `ASKED_FIRST`, `reachedLimit`, `running` | the sentences of "Waiting for you"                                                                                      |
| `ago(from, now)`                                                        | "now", "4 min", "1 h", "yesterday", "4 d"                                                                               |
| `THEME_WORDS`                                                           | System, Light, Dark                                                                                                     |

A page that needs a word or a sentence pattern that is not there adds it
there. A page never prints a protocol name as prose; it prints an id with
`Mono`.

## Themes — `lib/theme.ts`, `lib/theme-server.ts`

Three states: `system`, `light`, `dark` (`THEME_CHOICES`). The choice is kept
in the cookie `vaubaan_theme` (`THEME_COOKIE`), not in `localStorage`, so that
the server renders it: `currentTheme()` (`theme-server.ts`) reads the `cookie`
header of the request, the root layout writes `data-theme` on `<html>`
(`themeAttribute`: nothing for `system`), and the document arrives in the
right theme with no inline script — nothing flashes.

- `parseTheme(raw)` accepts `light` and `dark`; anything else is `system`.
- `themeCookie(choice, secure)` is the `document.cookie` assignment: one year,
  `SameSite=Lax`, `Secure` on https; `system` deletes the cookie. It is not
  `HttpOnly` on purpose — the toggle writes it — and carries a display
  preference only.
- `useTheme(initial)` (`components/shell/ThemeToggle.tsx`) is a
  `useSyncExternalStore` over the `data-theme` attribute of `<html>`: the
  attribute is the store, so the toggle of the shell and the control of
  Settings stay in step. `initial` is what the server rendered.
- Without an attribute the style sheet follows `prefers-color-scheme`.

## Tokens — `styles/tokens.css`

One layer of named decisions (spec [style-guide](../spec/style-guide.md) §3).

- `:root` holds what does not depend on the theme: the two font tokens
  (`--font-sans`, `--font-mono`, over the variables of the `geist` package),
  four sizes (`--text-xs` 12 px, `--text-sm` 13, `--text-base` 14,
  `--text-title` 20), two weights (`--weight-regular`, `--weight-strong`),
  `--leading`, `--measure` (680 px, the cap of a line of prose), the space
  scale (`--space-half`, `--space-1` … `--space-12`), the page rhythm
  (`--page-max`, `--page-max-narrow`, `--page-max-wide`, `--page-pad-x`,
  `--section-gap`, `--side-width`, `--side-width-collapsed`, `--row-y`,
  `--cell-y`, `--cell-x`), three control heights, four radii, two durations and
  one easing, and the six mark hues (`--hue-0` … `--hue-5`, `--on-hue`).
- `:root, [data-theme='light']` holds the light colours; `[data-theme='dark']`
  the dark ones; and `@media (prefers-color-scheme: dark)` repeats the dark
  values for `:root:not([data-theme])`. The dark values are written twice
  because a media query and an attribute cannot share a rule; a test keeps
  the two blocks identical.
- The theme selectors are not tied to `:root`: any element with `data-theme`
  re-declares the colours for what it contains. The gallery uses it to draw
  both themes on one page.
- Colours are plain hex values so that the contrast test can read them.

The colours: `--paper`, `--paper-side`, `--paper-raised`, `--fill`, `--hover`;
`--line`, `--line-strong`; `--ink`, `--ink-2`, `--ink-3`, `--ink-4`;
`--accent`, `--accent-ink`, `--accent-soft`, `--accent-line`, `--on-accent`;
`--ok`, `--warn`, `--bad`, each with `-soft` and `-line`, and `--on-warn`; the
`--code-*` set; `--scrim`, `--shadow-overlay`, `--knob`; `--focus-ring`.

The tokens of the first interface (the gray and status scales, the semantic
`surface-*` / `text-*` / `border-*` names, the nine `type-*` hues and their
`[data-kind]` rules) are gone. The style sheets of the pages written before
the redesign were moved to the new names one for one, so those pages read the
new palette without having been redesigned.

## One root, several module graphs

The composition root is built once per process, but a page is bundled apart
from the code that built it (another route, the instrumentation file, the
launcher of the browser tests). A class a page imports is therefore not
necessarily the class a service of the root instantiated: `err instanceof
ShareError` in a page can be false for a `ShareError` the service threw, and
the page then answers 500 instead of "not found". A page recognises a service
error by shape — `isShareError(err, code)`, `isConnectError(err, code)`
(name and code) — and services and handlers, which live in the root's own
graph, keep `instanceof`.

## A page shows what its service decides

A control a page shows or hides follows a rule the server enforces. That rule
is written once, next to the act it guards, and the page reads it from the
view it already loads. A page never spells the condition again.

| Rule                                                           | Stated in                                                    | Read by the page as                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a revoked or unowned connection takes no owner act (spec §2.3) | `ownerActRefusal(connection)` (`connections/service.ts`)     | `ShareContext.unshareable` (the Share dialog prints `SHARE_ERROR_MESSAGES[unshareable]`; the connection page hides Share, the actions of each share row and Reconnect) |
| the same, for a transfer                                       | `ConnectionService.transferTargets` returns no group         | the Ownership card shows when a target is listed                                                                                                                       |
| the gates of a revoked or orphaned mission are not edited      | `gateEditBlockedBy(mission)` (`missions/mission-service.ts`) | `MissionDetail.gates_editable`                                                                                                                                         |
| a group without member is not named owner                      | `ConnectionService.reassignTargets()`                        | the group list of Admin → Connections                                                                                                                                  |

`share`, `transfer`, the reconnection, `setGate` and `reassign` refuse on the
same functions, and `tests/integration/authority/rules-read-by-pages.test.ts`
asserts, on one state, what the reader says and what the act then answers.
The statuses a page still tests itself (`revoked`, `unowned` on the connection
page) choose a banner or a read-only field: what is displayed, not what is
allowed.

## The design system — `components/ui/`

Imported from `@/components/ui` (`index.ts`). Each component has its CSS
module beside it and reads the tokens only. **A page is built from these; a
component a page misses is added here, never in the page.** The rule of use of
each one is in its file header and on the gallery.

**The frame of a page**

| Export                                                      | What it is                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PageHeader`, `Crumbs`                                      | crumbs, the `h1`, a one-sentence `lede`, `primary` (one action), `secondary` (a tuple of one or two: the type refuses a third), `more`, `mark` and `status` beside the title, `width` (`narrow`, `default`, `wide`: the measure of the page column), `level={2}` inside another page |
| `Section`, `SectionHeading`                                 | a `<section>` named by its heading; `title`, `count`, `note` (a sentence or a link on the right); `first` removes the gap above the first region                                                                                                                                     |
| `SummaryLine`, `KeyValue`, `Stats`, `Hint`                  | counts that lead elsewhere (an item with `href` is a link); a definition list; labelled figures (a `tone` only on the exception); quiet text under a list                                                                                                                            |
| `SubNav`, `SubNavFrame`                                     | client. The local navigation of a page that is a small place of its own, and the grid that lays it beside the content; an item is current by path, or by `current` when the page navigates by fragment                                                                               |
| `Card`, `CardHeader`, `CardTitle`, `CardBody`, `CardFooter` | the one bordered box of a page (the rail)                                                                                                                                                                                                                                            |
| `Container`, `Stack`                                        | the column of a page outside the shell; a vertical flex with a `gap`                                                                                                                                                                                                                 |

**Lists and tables**

| Export                                      | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Rows`, `Row`                               | a `<ul>` of quiet rows: `lead` (a mark), `title` (a link with `href`), `description`, `aside` (at most one thing), `end` (an action or a short fact), `muted`                                                                                                                                                                                                                                                                                     |
| `DataTable`, `Column`                       | a typed table: `columns` (`id`, `header`, `cell`, `align`, `nowrap`, `width`, `detail`), `rows` or `groups`, `rowKey`, a required `caption` (not drawn), `actions` (shown on hover and on focus), `rowTone` (`bad`, `warn`, `quiet`), `rowDetail`, `headless`, `density`, `empty`. **Five columns by default, seven with details**: `checkColumnBudget` throws beyond that; `columnBudget={6}` is the documented exception of the activity record |
| `Table`, `Thead`, `Tbody`, `Tr`, `Th`, `Td` | the bare elements with the same look, for the pages written before the redesign                                                                                                                                                                                                                                                                                                                                                                   |
| `Meter`, `meterState`, `NEAR_LIMIT`         | `used`, `limit`, `threshold` (a share of the limit, default 0.6): below it a dash (`placeholder="none"` renders nothing) that still says the figure to assistive technology; near it an amber bar; at the limit a red one and "Limit reached". `threshold={0}` always draws. `format="percent"`, `label`                                                                                                                                          |

**Marks**

| Export                                         | What it is                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StatusMark`, `Dot`, `Tag`, `EnvTag`           | a pill with a dot for an exception (`tone`: `neutral`, `info`, `ok`, `warn`, `bad`); the dot alone; a squared tag for a fact that is not a state; an environment label (`null` → "no label", dashed)                                  |
| `Badge`, `BadgeTone`, `toneOfBadge`            | the inline label of the earlier pages, drawn as a tag; its tone names (`success`, `warning`, `danger`) map to the new ones                                                                                                            |
| `Avatar`, `AvatarStack`, `KeyHolder`           | a person (round), a machine key (`kind="machine"`: dashed square, no hue), a team; three sizes; the hue comes from the name (`hueOf`), the letters from `initialsOf`; the name and its qualifiers                                     |
| `ServiceMark`, `KeyMark`, `AgentLabel`, `Mono` | the two letters of a service (from its display name, never from a list of services); a masked key in mono; the label an agent gave itself; an identifier in mono that wraps between its words                                         |
| `SeverityChip`, `GateMark`, `WhyCells`         | one severity word; "runs freely" / "ask me first" / "not included" with a dot; the six cells of the risk model in words                                                                                                               |
| `Icon`, `IconName`                             | sixteen-pixel line icons on a 24-unit grid, drawn in `Icon.tsx`: the seven of the navigation, `search`, `sun`, `moon`, `system`, `check`, `cross`, `alert`, `info`, `key`, `copy`, `chevron`, `more`, `signout`; always `aria-hidden` |

**Permissions, answers, states**

| Export                                                                    | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PermissionTable`, `PermissionGroup`, `PermissionRow`                     | client. The table chooses its columns by `variant`: `editor` (tick, permission, risk, per day, per minute, ask me first), `read`, `usage` (used today, per minute, gate), `pick` (tick, permission, risk). A row takes `label`, `id` (mono, under the label), `severity`, `included`, `select`, `usage`, `perDay`, `perMinute`, `gate`, `gateControl`, `tag`, and `why` (`reason`, `cells`, `referenceHref`, `tools`), closed behind "why?" |
| `AllowSummary`                                                            | Can / Asks you first / Cannot, and "Limits today" when given; the asking line is left out when nothing asks; `asksLabel` for someone else's mission; `compact` in the rail                                                                                                                                                                                                                                                                  |
| `AnswerList`, `AnswerRow`                                                 | what waits for the person: `who`, `title`, `age`, `description`, `answers`; `boxed` is the one filled (amber) box of a page                                                                                                                                                                                                                                                                                                                 |
| `EmptyState`, `Lede`, `ModelDiagram`, `StepMark`, `CheckMark`, `Skeleton` | one sentence and one action; the paragraph and the drawn model of a first run; the lead of a step row and of a checklist row; the shape of what is loading                                                                                                                                                                                                                                                                                  |
| `Callout`, `Banner`                                                       | a note with an optional `title`, a `tone`, an optional `action`; `role="note"`. `Banner` is the same component under the name the earlier pages import                                                                                                                                                                                                                                                                                      |

**Actions, overlays, details, forms**

| Export                                                                     | What it is                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Button`, `ButtonLink`                                                     | `variant` (`primary` — the accent —, `secondary`, `ghost`, `danger`), `size` (`sm` 26 px, `md` 30 px, `lg` 36 px; the two small ones answer on 32 px), `loading`. `ButtonLink` is a link with the same look (`external` for a plain `<a>`)                                                                                                                               |
| `Dialog`, `DialogPanel`, `ConfirmDialog`, `OptionCard`, `DangerConfirm`    | client. A native `<dialog>` opened with `showModal()`: the browser keeps the focus inside, Escape and the backdrop call `onClose` (not while `dismissible` is false). `ConfirmDialog` takes a required `consequence`, optional `options` (radio cards), a `confirmLabel` named after the act, `tone`, `busy`, `error`, `hint`. `DangerConfirm` asks for a typed `phrase` |
| `ToastProvider`, `useToast`, `ToastCard`                                   | client. Mounted once by the shell; `useToast()` returns `toast({ title, description?, tone? })`; announced politely; leaves after five seconds unless it is a failure                                                                                                                                                                                                    |
| `Disclosure`, `DetailScope`, `DetailToggle`, `DetailOnly`, `useRemembered` | client. Details on demand, remembered in `localStorage` under `vaubaan:open:<id>` (`id` names the page and the region). A scope flips `data-details` on a wrapper: the `detail` columns of a `DataTable` and any `DetailOnly` block inside follow it, even when rendered by the server                                                                                   |
| `TabList`, `TabPanel`, `TabItem`                                           | client. Tabs with the ARIA roles and keyboard; the state belongs to the caller                                                                                                                                                                                                                                                                                           |
| `Segmented`, `FilterChips`, `SearchField`, `FilterOption`                  | client. One choice among a few; facets that add up; a search field. An option with `href` is a link (the filter lives in the URL), otherwise a button                                                                                                                                                                                                                    |
| `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`      | `Field` takes `label`, `htmlFor`, `shape` (the expected shape, said in the label), `optional`, `hint`, `error`; it gives its control `aria-describedby` and, with an error, `aria-invalid`. Controls take `size="sm"` and `mono`                                                                                                                                         |
| `Code`, `CodeBlock`, `CodeTone`, `CopyButton`                              | inline code; a dark block with a Copy button that copies `copy` (or the text when it is a plain string); a keyword, a string or a comment inside a block; a copy button on its own                                                                                                                                                                                       |

**Labels are bound to their controls.** A `Field` that holds one control
takes `htmlFor`, the `id` of that control, and renders a real `<label for>`.
A `Field` that holds several controls (the claim mapping of the identity
provider) takes no `htmlFor`: its wrapper is a `role="group"` named by the
label, and each control carries its own `aria-label`. Ids must be unique on
the page: `CredentialFieldInputs` (`components/connections/parts.tsx`) takes an
`idPrefix`; Administration → Company apps passes `provider-app-<provider id>`
because it renders one list per provider.

**Server or client.** Everything not marked "client" above has no hook and
renders in server and client components alike. A client component takes
rendered nodes from a server page (`select`, `usage`, `answers`), never a
function.

### The gallery — `/design`

`(app)/design/` renders every component in every state: `page.tsx`
(`requirePrincipal()`, any session) and a client gallery (`gallery.tsx`,
three files of sections, `specimen.tsx`). A `Specimen` draws its content twice,
on an island with `data-theme="light"` and on one with `data-theme="dark"`, so
both themes are compared on one screen whatever the theme of the page. Every
value on it is invented. It is linked from Settings, and it is what a page is
compared with in review. Adding a component, a variant or a state means adding
its specimen.

### Legacy primitives

Kept for the pages written before the redesign, restyled through the tokens,
and removed with the last page that imports them:

- `Slug` — a name with the glyph of its kind and a visually hidden word for
  it (`data-kind`, `data-kind-label`); it carries no colour of its own any
  more. A redesigned page uses `Mono` and `KeyMark` and says the kind in
  words.
- `Glyph`, `GlyphName` — the twelve-pixel glyph set of the kinds, plus `help`,
  `chevron`, `warning`, `info`, `key`, `flask`, `archive`, `user`.
- `KindLegend`, `ITEM_KINDS`, `ITEM_KIND_WORDS`, `ItemKind` (`kinds.ts`) — the
  list of kinds and the legend of their glyphs (the reference pages).
- `Help`, `HelpButton`, `useHelp` — one line and a "More" button
  (`vaubaan:help:<id>`). A redesigned page uses a one-sentence lede and
  `Disclosure`.

### Display helpers

Shared by the pages that used to carry a copy each:

- `components/risk/RiskExplain.tsx`: how a risk is explained everywhere —
  `RiskExplain` (a compact row: label and class, id and one line of reason
  that unfolds, the vector strip), `VectorStrip`, `VectorLegend`,
  `RiskIdLink`, `RiskClassTag`, `RiskReason`, `RiskMarkers`, `RiskMarkerNotes` (handbook
  [missions](missions.md), "How a risk is explained"). The Custom editor of
  mission creation, the Share dialog, the mission page and the provider
  reference render a risk through it; the Requests pages, the session page,
  Audit, Shares received and the connection page print each risk id with
  `RiskIdLink`, a `Slug` of kind `risk`;

- `components/risk/RiskBadges.tsx`: `SeverityBadge({ level })`, the catalog
  severity with its tone (Shares received, the Share dialog, the mission form),
  and `GateBadge({ gate })`, `approval` as a warning badge and `auto` as the
  plain word (mission page, session page, request page);
- `app/(app)/missions/message-of.ts`: `messageOf(body, status)`, the `message`
  of a JSON refusal of the mission API or "The instance answered `<status>`."
  (gate control, rotate and revoke, the mission form);
- `components/auth/principal.ts`: `isOperatorPrincipal(principal)`
  ([The shell](#the-shell--componentsshell)).

`components/LocalDate.tsx` (client) renders a timestamp: the ISO form on the
server, the browser's locale after hydration, without a hydration mismatch.
`dateOnly` drops the time. The Missions list, the mission page, its session
page, the Requests pages, Audit, Delegations and three Administration pages
(`/admin`, `/admin/bootstrap`, `/admin/oauth-clients`) and Shares received
use it; the Connections list and the connection page still print the UTC day
(`iso.slice(0, 10)`).

The other shared components belong to one feature and are described in its
handbook:

- `components/connections/parts.tsx` (server): `StateBadge({ status })` for a
  connection status, `ExperimentalBadge`, `NoticeBanner({ notice })` for the
  one-time notice a redirect left, `credentialKindLabel(kind)` and
  `CredentialFieldInputs` with `credentialFieldId`
  ([connections](connections.md));
- `components/connections/RevokeConnection.tsx` (client): the Revoke button of
  a connection, a `DangerConfirm` whose phrase is the connection name and
  whose confirmation submits a plain POST form;
- `components/telemetry/ValidationBadge.tsx`: the community validation status
  on the Connections list and the connection page, nothing when there is no
  status ([telemetry](telemetry.md));
- `app/(app)/missions/state-badge.tsx`: `StateBadge({ state })` for a mission
  state, with the count of exhausted risks on an active mission
  ([missions](missions.md));
- `components/auth/PrincipalCard.tsx`: `PrincipalCard`, `OperatorBadge` and
  `SignOutButton` (a plain `POST /logout` form)
  ([authentication](authentication.md)).

## The provider reference — `/reference`

Documentation of the instance inside the instance (spec §4.2 "Providers"): what
each shipped plugin connects to and what a mission can accept on it. Both pages
call `requirePrincipal()`: any session reads them, the bootstrap operator
included; they show no connection, no mission and no credential. The
structural test of the surface (`tests/unit/app/app-guard.test.ts`) lists them
with `/activity` among the pages open to any session.

Everything is generated from the plugin registry by
`src/server/providers/reference.ts` (pure, no IO); no provider has a
hand-written page, and a plugin added to the registry has its page.

| Function                               | Gives                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providerCards(registry)`              | the index: name, one-line description, credential kind, counts (risks, presets, tools), the planes of the model, the environments of the catalog; experimental ones last |
| `providerReference(registry, id)`      | the whole page of one plugin, or `null` (the page answers "not found")                                                                                                   |
| `dataModelTrees(model)`                | each plane as a containment tree: entity, cardinalities, "carries the environment"                                                                                       |
| `describePattern(pattern)`             | a slice pattern read as words: `Write: repo (any) › branch (main, master) › file (any)`; the fallback pattern reads "Write anything in `<provider>`"                     |
| `presetReferenceOf(preset, risks)`     | a preset against the whole catalog: lines without asking, lines under approval, entries not included                                                                     |
| `riskExplainer(registry)`              | `(riskId) → CatalogRisk \| null`, for the pages that list a persisted policy                                                                                             |
| `planesOfPatterns`, `planesOfToolName` | `planes.ts`: the planes a catalog entry or a tool is filed under (below)                                                                                                 |
| `riskPlanesOf(model, catalog)`         | `planes.ts`: per catalog entry its planes, or `null` for a model with one plane; what the Custom editor's plane filter reads                                             |

A `RiskReference` also names the presets that include it (`presets`: id, label,
anchor), the tools the plugin declares for it (`declared_tools`, from
`tokenHandouts`) and its `planes`; a `ToolReference` has its `planes`; the
reference has `plane_filters` (slug, description, counts), empty when the
model has one plane.

**The index** (`providers/page.tsx`) is a grid of cards. A card differs from
its neighbours by what it holds: the name, the credential kind, the one-line
description, the planes of the model as `plane` slugs, the environments the
catalog knows, `experimental` and the community validation badge, and three
counts with the glyph of their kind (presets, risks, tools). The lead is one
line; the rest, with the legend of the glyphs, is behind "More".

**`/reference/<id>`** is a compact header rendered by the server (`[id]/page.tsx`)
and a client body (`[id]/provider-view.tsx`):

- **Header** — name, `experimental`, the community validation badge
  (`root.telemetry.stats.statusFor`, absent when telemetry gives none); plugin
  and catalog versions and the maintainer handbook link (`docsUrl`) on one
  monospace line; the plugin's `summary` (plain words: what a connection is,
  what a resource is, where the environment comes from —
  [plugin-sdk](plugin-sdk.md)); three facts in one row: what it connects to,
  the credential kind, the environments with where they come from.
- **Tabs** (`TabList`, sticky under the top of the window) — one section in
  view at a time, in the order a reader needs them: **Presets** (the default),
  **Risks**, **Data model**, **Tools**; Presets, Risks and Tools carry a count.
  Selecting a tab writes its fragment (`#presets`, `#risks`, `#data-model`, `#tools`).
- **Plane control** — only when the model has several planes (today
  Supabase): native radios drawn as pills, "All", one per plane, and `other`
  when something is filed there. It slices every tab at once: the rows of the
  matrix, the risk list, the outline, the tools, and the counts on the tabs.
  `data-testid="plane-control"`.
- **Help** — "How to read this page" (`useHelp('provider-reference')`,
  `#legend` opens it): presets and risks in one paragraph, how to read a risk
  with the legend of the six axes and the two markers, what the glyphs mean
  (`KindLegend`: the glyph of each kind — kinds carry no colour any more), how planes are read. Closed by default.

The four sections, one file each beside the page:

1. **Presets** (`preset-matrix.tsx`, `#presets`) — one table: a column per
   preset (`<th id="preset-<id>">`, a band, its label, its
   counts, its description on three lines), a row per catalog entry grouped
   into reads, writes and irreversible writes. A cell is the budget the preset
   gives the risk — quota, rate limit, gate (`approval` as a badge) — once per
   environment for an env-scoped risk, or a dash ("not included" to assistive
   technology). The risk label and its id link to its entry in the Risks tab.
   `data-testid`: `preset-matrix`, `preset-<id>`,
   `cell-<preset id>-<risk id>`.
2. **Risks** (`risk-list.tsx`, `#risks`) — the three groups, each under a
   title that sticks below the tabs, as compact rows
   (`<article id="risk-<id>">`): the label as a disclosure button, the severity
   and the markers; the vector strip of its most severe variant; then the id,
   one line of reason, the environments and the presets that include it as
   `preset` slugs. Unfolded: the whole reason, a `Callout` per note (fallback,
   deprecated with its replacement, token hand-out), the scope with the
   explicit id per environment, the profile per environment when an override
   changes it, each pattern in words with the pattern under it, the declared
   tools, the plugin's rate ceiling. "Expand all" unfolds the list. An entry is
   listed once, under the kind of its most severe variant, so its anchor is
   unique. Fifteen entries, collapsed, measure about one and a half viewports
   at 1280×800 (the browser test bounds it at 1.75).
3. **Data model** (`data-model.tsx`, `#data-model`) — where the environment of
   a call comes from (`EnvironmentReference.source`: `none` when the catalog has
   no env-scoped entry; otherwise `call` when the plugin declares `envOf`, and
   `resource-label` when it does not), then each plane as an outline with connectors: the
   entity, its cardinalities as small annotations, its description; the
   carrier of the environment has a badge and a band.
4. **Tools** (`tool-table.tsx`, `#tools`) — a dense table: the name as a
   `tool` slug, the description, required and optional arguments, the plane
   when the model has several, and the risks. The columns have fixed shares
   of the width (`reference.module.css`: tool 29 %, arguments 16 %, plane
   10 %, risks 19 %, the description taking the rest), so that a qualified
   risk id (`github.mint-install-token-clone`) holds on two lines at most. The
   "Risks" column reads "by
   arguments": a plugin classifies a call from its arguments and declares no
   table of the risks of each tool; the page says so in one line and the rest
   (`TOOL_RISKS_NOTE`: `tools/list` is filtered per provider, a listed tool can
   still be refused, the catalog endpoint of the execution door is the precise
   source) is behind "More". The one exception is a tool the plugin declares
   in `tokenHandouts` ([plugin-sdk](plugin-sdk.md)): its row lists the
   declared risks under a **"hands a token to the agent"** badge, a callout
   above the table states `TOKEN_HANDOUT_NOTE` (spec §2.4), and each of those
   risks carries a badge that says what the token can do —
   **"hands a read-only token"** (warning tone) or **"hands a write token"**
   (danger tone), from `RiskReference.token_access`, which follows the
   plugin's `readOnlyRiskIds` — and, unfolded, the callout and the tool. The
   note says the preset rule: a token that can write is handed only after the
   creator approves the call, a read-only one may be handed without asking.
   Today that is `github__mint_install_token`, `github.mint-install-token-clone`
   (read-only, `auto` in the Developer preset) and
   `github.mint-install-token-push` (write, `approval`).

**Fragments.** `ProviderView` reads the fragment when the page opens and on
every `hashchange` (`destinationOf`): a section id selects its tab;
`#risk-<id>` selects Risks, unfolds the entry, scrolls to it and outlines it,
and — when the plane in view does not show it — opens the entry's own plane;
`#preset-<id>` selects Presets and outlines the column. Links inside the page
call the same function, so the same link works twice in a row. What takes
focus or is scrolled to stays clear of the sticky bar (`scroll-margin-top` from
the measured height of the bar, `--bar-height`).

**Planes** (`server/providers/planes.ts`, pure and browser-safe). Nothing is
declared per risk or per tool, so the plane is read from what is declared and
never guessed: a risk belongs to the plane of the first entity of its pattern
that one plane alone declares (`project` is the root of every Supabase plane
and decides nothing); a tool, which declares no pattern, is filed under a plane
only when its name contains the name of such an entity, the longest name
winning. Whatever names none goes to `other` (`OTHER_PLANE`): on Supabase the
two catch-all risks (`read-data`, `uncategorized-write`) and the tools whose
name says nothing of a plane (`get_project`, `execute_sql`, the
`*_function` tools…). The same map feeds the plane filter of the Custom editor
([missions](missions.md)).

`src/server/providers/links.ts` (browser-safe) is the only place that builds
those URLs and anchors: `providerPath`, `riskReferencePath`,
`presetReferencePath`, `sectionPath`, `riskAnchor`, `presetAnchor`. The
reference is linked from the connection page ("Provider" row), the "Connect a
provider" picker (under each card) and the connect form, the Share dialog,
mission creation (page lead, each preset, the Custom toolbar, each risk id),
the mission page (each provider name, each risk id), the Requests pages, the
session page and Shares received.

## What the standalone output carries

The image runs `.next/standalone/apps/gateway/server.js` and copies the standalone tree
whole (`deploy/docker/Dockerfile`), so what the build traces into it is what ships.
`next.config.ts` adds what the tracer cannot see (`outputFileTracingIncludes`: the native
addons, the migrations, the plugin catalogs) and removes what must never ship
(`outputFileTracingExcludes`, the list `NEVER_SHIPPED`: `tests/**`, every `*.test.ts(x)`
under `src/`, `tsconfig.tsbuildinfo`).

Two guards keep the tests out of the output, because of one line of the plugin SDK:
`catalogPathNextTo` (`packages/plugin-sdk/src/catalog-path.ts`) joins a path computed at
run time, and Turbopack answers a computed filesystem path by tracing the whole
application directory into every entry that reaches it ("Dynamic filesystem access causes
tracing of the whole project"). Every route, and the boot hook, reach the plugins through
the composition root.

- **At the source.** The `join` of `catalogPathNextTo` carries a
  `/* turbopackIgnore: true */` hint: the tracer leaves the computed path alone, and the
  catalogs themselves are listed in `outputFileTracingIncludes`. This is the guard that
  covers the trace of the boot hook (`src/instrumentation.ts` →
  `.next/server/instrumentation.js.nft.json`), which no key of
  `outputFileTracingExcludes` reaches: Turbopack applies that option to route traces only.
- **In the configuration.** `outputFileTracingExcludes` with `NEVER_SHIPPED` is the second
  guard, for the route traces.

`tests/integration/standalone-plugin-catalogs.test.ts` (3, skipped without a build) holds
the result: every plugin catalog is in the standalone tree next to its module, no trace
under `.next/server` — a route's or the boot hook's — names a test file, the standalone
tree holds none, and `apps/gateway/server.js` is there.

Nothing at run time needs those files: the browser suite starts the standalone server
from the repository's sources and copies `public/` and `.next/static` beside it itself,
as the Dockerfile does.

## Adding a page

1. **Place it** under `(app)/` to get the session redirect and the shell, under
   `admin/(guarded)/` for a page of Administration, under `(public)/` if it
   must work without a session. A page belongs to one of the seven entries:
   if its path is not under an entry's, add it to `ALSO_UNDER` in
   `components/shell/nav.ts`. Do not add an eighth entry.
2. **Authenticate in the page itself**, as its first statement, with the
   session helper that fits ([Session helpers](#session-helpers--libauthsessionts)):
   `currentUser()` then `if (!session) return <NeedsUser />;` for a page that
   needs a user, `requirePrincipal()` for a page open to the bootstrap operator
   too, `requireOperator()` under `admin/(guarded)`. Never rely on the layout,
   and never read the root before the guard. A page under `(app)` that calls
   none of them fails `tests/unit/app/app-guard.test.ts`.
3. **Load data in the server component** from the services on `root`, and
   export `dynamic = 'force-dynamic'`.
4. **Mutations are POST route handlers** (`runtime = 'nodejs'`,
   `dynamic = 'force-dynamic'`) that delegate to a handler under
   `src/server/<module>/handlers.ts`. That handler checks
   `isSameOrigin(headers, publicUrl)` first (403 `origin-mismatch`), then the
   session, then calls the service. Plain HTML `method="post"` forms answer
   with a redirect (a message goes through the `NoticeStore`, never the URL:
   [connections](connections.md)); the mission endpoints answer JSON to their
   client components.
5. **Build it from the design system**: a `PageHeader` (one sentence of lede,
   one primary action), `Section`s, then rows, tables and the rest. Take every
   word from `lib/vocabulary.ts`. Hold the attention budget (spec
   [style-guide](../spec/style-guide.md) §1): three regions above the fold,
   five columns, a meter only near a limit, colour for the exception only,
   detail behind a `Disclosure` or a `DetailScope`. A page-specific layout goes
   in a CSS module next to the page and reads the tokens only; a missing
   component goes into `components/ui` with its specimen on `/design`.
6. **Look at it**: at 1440×900 and 1280×800, in both themes, beside the
   gallery.
7. **Document it** in the handbook of its feature and add its route to the map
   above. If it replaces a path people may have bookmarked, add the old path
   to `LEGACY_REDIRECTS`.

## Tests

Unit files under `apps/gateway/tests/unit/app/` run without a browser
(`npx vitest run apps/gateway/tests/unit/app`):

- `app-guard.test.ts` discovers every `page.tsx` and `route.ts` under `(app)`.
  Each page must call a session helper before it reads the root, redirect a
  visitor with no session (and a bootstrap session whose token was revoked) to
  `/login`, render only `NeedsUser` for the bootstrap operator (`/activity`,
  the two `/reference` pages, `/settings` and `/design` excepted), and render
  or answer "not found" for a signed-in user. Each route must delegate to a
  handler listed as authenticating, refuse a caller with no session and the
  bootstrap operator, and let a signed-in user through.
- `admin-guard.test.ts` does the same for `admin/(guarded)` with
  `requireOperator()` ([authentication](authentication.md)).
- `design-tokens.test.ts` reads `tokens.css` and every style sheet: the two
  dark blocks hold the same values and both themes the same tokens; four text
  sizes and two weights; every documented pair of text and surface meets AA in
  both themes (`ink-4` is below it on purpose); every token is used and every
  `var(--…)` resolves; no raw colour outside the token sheet; a font size is a
  token or relative.
- `shell-and-vocabulary.test.ts`: the seven entries in order, each leading to
  a page that exists; `sectionOf` for every area; the local navigation of
  Settings (its pages exist, no label twice); the path constants of the server
  equal the routes; every rule of `LEGACY_REDIRECTS` lands on a page or a
  route that exists and none matches the provider callback; the theme helpers;
  the sentence patterns of the vocabulary.
- `design-system.test.tsx` renders the components to static markup: one `h1`
  and the order of the actions of a page header; the meter and its threshold;
  the column budget of `DataTable`, its caption, detail columns and row tones;
  marks that carry their word; the columns of each `PermissionTable` variant
  and the closed "why?"; the lines of `AllowSummary`; `Field` tying its error
  to its control; a dialog stating its consequence before its button.
- `field.test.tsx` renders `Field` and `CredentialFieldInputs`: label bound by
  `for`/`id`, group role without `htmlFor`, unique ids when two lists share a
  page.
- `risk-explain.test.tsx` renders `Slug`, `RiskIdLink`, `KindLegend`,
  `VectorStrip`, `RiskExplain`, `Help` and `Callout` to static markup.
- `build-footer.test.tsx` renders the footer (given stamps, the stamps of the
  build, `dev`), and `tests/unit/structural/version-single-source.test.ts`
  checks that the build stamps the version of the root `package.json`.

`guard-harness.ts` holds what the two guard files share (file discovery,
calling a page as a function, naming a redirect or a "not found").

`server/providers/planes.test.ts` covers the plane rules on a two-plane model
and on the shipped Supabase and GitHub plugins. Three helpers have a unit file
beside them: `components/auth/principal.test.ts`,
`app/(app)/missions/message-of.test.ts` and
`app/(app)/missions/new/form-state.test.ts`.

In a browser, the Playwright suite `apps/gateway/tests/e2e/v5/`
(`npm run test:e2e:v5`, nine specs) exercises the rest. `shell.spec.ts` is the
frame's own: one home and seven entries, each leading to a page and then
marked; the person's menu and the skip link; the collapsed navigation at
900 px and the bar at 390 px; the three states of the theme, kept across a
reload and present in the HTML the server sends; a 308 from every old path
and none from the provider callback; Settings for a person and for an
administrator; and the gallery — every section of its navigation, every
specimen on a light and a dark island, "show details" remembered, a meter
drawn only near its limit, "why?", a confirmation closed by Escape and a
toast. The other specs follow the journeys of each feature through the new
navigation ([e2e tests](../tests/e2e-tests.md)). What a page decides is tested
without Next, in the unit and integration suites of its `src/server/**` module
(`npm test`); see each feature handbook.

## References

- Spec [style-guide](../spec/style-guide.md); [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2.
- ADR [interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md).
- Handbooks: [authentication](authentication.md),
  [connections](connections.md), [authority](authority.md),
  [missions](missions.md), [requests](requests.md), [audit](audit.md),
  [execution-door](execution-door.md), [management-door](management-door.md),
  [telemetry](telemetry.md), [configuration](configuration.md).
- v4 text: [legacy/web-app.md](legacy/web-app.md).
