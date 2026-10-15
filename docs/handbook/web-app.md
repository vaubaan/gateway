---
title: Web app — route map, layouts, shell, design system
status: current
date: 2026-10-13
last_synced: 2026-10-14
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
  - apps/gateway/src/lib/dates.ts
  - apps/gateway/src/lib/theme.ts
  - apps/gateway/src/lib/theme-server.ts
  - apps/gateway/src/app/(app)/design/
  - apps/gateway/src/app/(app)/settings/
  - apps/gateway/src/app/(app)/settings/connected-apps/layout.tsx
  - apps/gateway/src/components/settings/
  - apps/gateway/src/components/LocalDate.tsx
  - apps/gateway/src/components/RelativeTime.tsx
  - apps/gateway/src/components/auth/NeedsUser.tsx
  - apps/gateway/src/components/auth/AuthPage.tsx
  - apps/gateway/src/app/(app)/_now/
  - apps/gateway/src/app/(app)/not-found.tsx
  - apps/gateway/src/app/(app)/error.tsx
  - apps/gateway/src/app/not-found.tsx
  - apps/gateway/src/app/error.tsx
  - apps/gateway/src/app/global-error.tsx
  - apps/gateway/src/server/now/
  - apps/gateway/src/server/http/document.ts
  - apps/gateway/tests/integration/now/
  - apps/gateway/src/components/auth/principal.ts
  - apps/gateway/src/components/connections/
  - apps/gateway/src/server/providers/
  - apps/gateway/src/server/oauth-as/pages.ts
  - apps/gateway/src/app/admin/bootstrap/page.tsx
  - apps/gateway/src/app/(app)/reference/
  - apps/gateway/src/components/telemetry/ValidationBadge.tsx
  - apps/gateway/src/app/(app)/missions/message-of.ts
  - apps/gateway/src/app/(app)/missions/mission-view.ts
  - apps/gateway/src/lib/auth/session.ts
  - apps/gateway/src/lib/connections/session.ts
  - apps/gateway/next.config.ts
  - apps/gateway/tests/unit/app/
  - apps/gateway/src/app/(app)/reference/[id]/page.tsx
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
  creation form with its preset panel and its permission editor ("Edit the permissions one by one"), the mission actions, the "ask me first" control
  of the mission page (`GateControl`), its "People and keys" section (`TeamSection`), the setup kit view, the "Give access" dialog
  (`GiveAccessDialog`), the confirmations of the account page (`RemoveAccess`, `TransferOwnership`,
  `RevokeConnection`, `CloseOrphanedMission`), `LocalDate` and the time of an activity line (`When`), the body of
  a service's reference (`ServiceView` and its sections), the gallery of
  `/design`, the parts of the shell that need the browser (`NavLinks`,
  `UserMenu`, `ThemeToggle`) and the components of the design system that hold
  state or read the path (marked "client" in
  [The design system](#the-design-system--componentsui)). The only
  `fetch` calls from the browser are the mission form (`POST /api/missions`,
  `POST /api/missions/preview`), the mission actions
  (`POST /api/missions/<id>/rotate|revoke`), the gate control
  (`POST /api/missions/<id>/gate`) and the "People and keys" section of the
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
- **`src/proxy.ts` decides nothing**: it sets the security headers and the
  nonce of the Content-Security-Policy (handbook [configuration](configuration.md),
  "Security headers"); each page and each handler authenticates itself. A link
  that starts a sign-in (`/auth/login/<id>`) is a plain link (`ButtonLink
external`), never prefetched.

## Route map

| Route                                                                                                                             | File under `apps/gateway/src/app/`                                                                                                             | Handbook                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/`                                                                                                                               | `(app)/page.tsx`, `(app)/_now/**`                                                                                                              | this handbook, [The home — Now](#the-home--now)                                              |
| `/settings`, `/design`                                                                                                            | `(app)/settings/page.tsx`, `(app)/design/**`                                                                                                   | this handbook, [The shell](#the-shell--componentsshell), [The gallery](#the-gallery--design) |
| `/login`                                                                                                                          | `(public)/login/page.tsx`, `(public)/layout.tsx`                                                                                               | [authentication](authentication.md)                                                          |
| `GET /auth/login[/<id>]`, `GET /auth/callback[/<id>]`                                                                             | `auth/login/route.ts`, `auth/login/[provider]/route.ts`, `auth/callback/route.ts`, `auth/callback/[provider]/route.ts`                         | [authentication](authentication.md)                                                          |
| `POST /logout`                                                                                                                    | `logout/route.ts`                                                                                                                              | [authentication](authentication.md)                                                          |
| `/admin/bootstrap`, `POST /api/auth/bootstrap`                                                                                    | `admin/bootstrap/page.tsx`, `api/auth/bootstrap/route.ts`                                                                                      | [authentication](authentication.md)                                                          |
| `/admin`, `/admin/identity-provider`, `…/new`, `…/<id>`                                                                           | `admin/(guarded)/page.tsx`, `admin/(guarded)/identity-provider/**`, `admin/(guarded)/layout.tsx`, `components/settings/SignInProviderForm.tsx` | [authentication](authentication.md)                                                          |
| `POST /api/admin/identity-provider`, `POST /api/admin/sign-in-providers`, `…/<id>/remove`                                         | `api/admin/identity-provider/route.ts`, `api/admin/sign-in-providers/**`                                                                       | [authentication](authentication.md)                                                          |
| `/admin/provider-apps`, `POST /admin/provider-apps/<provider>`                                                                    | `admin/(guarded)/provider-apps/**`                                                                                                             | [connections](connections.md)                                                                |
| `/admin/telemetry`, `POST /api/admin/telemetry`                                                                                   | `admin/(guarded)/telemetry/page.tsx`, `api/admin/telemetry/route.ts`                                                                           | [telemetry](telemetry.md)                                                                    |
| `/accounts`, `/accounts/new`, `/accounts/new/<provider>`, `/accounts/<id>`                                                        | `(app)/accounts/**/page.tsx`                                                                                                                   | [connections](connections.md)                                                                |
| `/accounts/<id>/share`, `POST /accounts/<id>/shares`, `…/shares/<id>/revoke`, `…/transfer`                                        | `(app)/accounts/[id]/share/`, `shares/`, `transfer/`                                                                                           | [authority](authority.md)                                                                    |
| `/admin/users`, `POST /admin/users/<id>/deactivate`, `…/<id>/reactivate`, `POST /admin/users/invitations`, `…/invitations/remove` | `admin/(guarded)/users/**`                                                                                                                     | [authentication](authentication.md)                                                          |
| `/admin/groups`, `POST /admin/groups/create`, `…/<id>/members[/<userId>/remove]`                                                  | `admin/(guarded)/groups/**`                                                                                                                    | [authority](authority.md)                                                                    |
| `/admin/connections`, `POST /admin/connections/<id>/reassign`                                                                     | `admin/(guarded)/connections/**`                                                                                                               | [authority](authority.md)                                                                    |
| `POST /accounts/connect/<provider>`, `GET /connections/callback/<provider>`                                                       | `(app)/accounts/connect/`, `(app)/connections/callback/`                                                                                       | [connections](connections.md)                                                                |
| `POST /accounts/<id>/discover`, `/revoke`, `/resources/<resourceId>`                                                              | `(app)/accounts/[id]/**/route.ts`                                                                                                              | [connections](connections.md)                                                                |
| `/missions`, `/missions/new`, `/missions/<id>`                                                                                    | `(app)/missions/page.tsx`, `(app)/missions/new/page.tsx`, `(app)/missions/[id]/page.tsx`                                                       | [missions](missions.md)                                                                      |
| `POST /api/missions`, `/api/missions/preview`, `/api/missions/<id>/rotate`, `/revoke`, `/gate`, `/members/**`, `/tokens/**`       | `api/missions/**/route.ts`                                                                                                                     | [missions](missions.md)                                                                      |
| `GET /agent-bootstrap.md`                                                                                                         | `agent-bootstrap.md/route.ts`                                                                                                                  | [missions](missions.md)                                                                      |
| `/missions/<id>/session`                                                                                                          | `(app)/missions/[id]/session/page.tsx`                                                                                                         | [audit](audit.md)                                                                            |
| `/activity`                                                                                                                       | `(app)/activity/page.tsx`                                                                                                                      | [audit](audit.md)                                                                            |
| `/reference`, `/reference/<id>`                                                                                                   | `(app)/reference/page.tsx`, `(app)/reference/[id]/page.tsx`                                                                                    | this handbook, [The provider reference](#the-provider-reference--reference)                  |
| `/waiting`, `/waiting/<id>`                                                                                                       | `(app)/waiting/**/page.tsx`                                                                                                                    | [requests](requests.md)                                                                      |
| `GET /r/<id>`                                                                                                                     | `r/[id]/route.ts`                                                                                                                              | [requests](requests.md)                                                                      |
| `GET /api/requests`, `POST /api/requests/<id>/decide`                                                                             | `api/requests/**/route.ts`                                                                                                                     | [requests](requests.md)                                                                      |
| `GET, POST, DELETE /mcp`, `GET /mcp/catalog`                                                                                      | `mcp/route.ts`, `mcp/catalog/route.ts`                                                                                                         | [execution-door](execution-door.md)                                                          |
| `GET /.well-known/oauth-protected-resource`                                                                                       | `.well-known/oauth-protected-resource/route.ts`                                                                                                | [execution-door](execution-door.md)                                                          |
| `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource/mcp/manage`                             | `.well-known/oauth-authorization-server/route.ts`, `.well-known/oauth-protected-resource/mcp/manage/route.ts`                                  | [management-door](management-door.md)                                                        |
| `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/authorize/decision`, `POST /oauth/token`, `POST /oauth/revoke`       | `oauth/**/route.ts`                                                                                                                            | [management-door](management-door.md)                                                        |
| `GET, POST, DELETE /mcp/manage`                                                                                                   | `mcp/manage/route.ts`                                                                                                                          | [management-door](management-door.md)                                                        |
| `/settings/connected-apps`, `POST …/<id>/revoke`                                                                                  | `(app)/settings/connected-apps/**`                                                                                                             | [management-door](management-door.md)                                                        |
| `/admin/oauth-clients`, `POST /admin/oauth-clients/<id>`                                                                          | `admin/(guarded)/oauth-clients/**`                                                                                                             | [management-door](management-door.md)                                                        |
| `GET /healthz`                                                                                                                    | `healthz/route.ts`                                                                                                                             | [configuration](configuration.md)                                                            |

`/` is the one home of a signed-in person (`(app)/page.tsx`: `currentUser()`,
then "Now", [below](#the-home--now)); a visitor without a session is sent to
`/login`. Every path the interface had before its words
changed answers with a permanent redirect
([Routes follow the words](#routes-follow-the-words--nextconfigts)).

The table names the method a caller uses. The three `.well-known` routes also
export `HEAD` and `OPTIONS`, and `POST /oauth/register`, `/oauth/token` and
`/oauth/revoke` also export `OPTIONS`, on the same handler
([management-door](management-door.md)). A segment that holds only a
`route.ts` has no page: `/accounts/<id>/shares`, `/accounts/connect/…`,
`/settings/connected-apps/<id>/revoke` and the `admin/(guarded)` mutations answer `POST`
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
  it renders its children and nothing else; the page draws its own frame
  (`AuthPage`, [Pages outside the shell](#pages-outside-the-shell)).
- **`not-found.tsx` and `error.tsx`**, at the root and under `(app)/`, and
  `global-error.tsx`: what is rendered for an address that matches nothing
  and for a page that failed, inside the shell and outside it (same section).
- **`(app)/layout.tsx`** — the human surface: `currentPrincipal()`; no
  principal → `redirect('/login')`; otherwise
  `<AppShell principal instance>`, `instance` being the host of the public URL.
- **`(app)/settings/connected-apps/layout.tsx`** — connected apps are a page of Settings: the
  page inside `SettingsFrame` (the local navigation of Settings).
- **`admin/(guarded)/layout.tsx`** — `adminDecision()`; no session → the
  admin sign-in; an administrator → `<AdminShell principal instance>`, the
  application shell with the local navigation of Settings
  ([The shell](#the-shell--componentsshell)); a signed-in person who is not one
  → the "You do not administer this gateway" explanation in a `Container`, followed by the build
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
had before (`/connections`, `/connections/<anything but callback>/**`,
`/requests/**`, `/audit`, `/providers/**`, and the two pages that were folded
into another: `/shares` → `/accounts`, `/delegations` →
`/settings/connected-apps` with `POST /delegations/<id>/revoke`);
`redirects()` answers each with a
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

What a colleague gave access to is a region of `/accounts` ("Shared with
you"), and connected apps are a page of Settings, under its path
(`ROUTES.connectedApps`, the server's `DELEGATIONS_PAGE`). The pages of the
administration keep `/admin/**` (ADR
[redesigned-pages-accounts-reference-activity-settings](../decisions/redesigned-pages-accounts-reference-activity-settings.md)).

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
  that needs a user": Missions, the mission session, Accounts (the "Give
  access" dialog included), Waiting for you and Connected apps all render
  `NeedsUser` (`components/auth/NeedsUser.tsx`), one note
  that says the install token owns no mission, account or request and
  links to Settings → Sign-in. No page redirects the bootstrap
  operator elsewhere.
- `currentActor()` (`lib/connections/session.ts`) is `currentUser()` plus the
  `Actor` (`{ user, groups }`) the connection service expects; the Accounts
  pages use it. The same file holds `firstParam`,
  `PageSearchParams` and `takeNotice`.
- `adminDecision()` is the undecorated answer behind `requireOperator()`
  (`{ root, decision }`): the `admin/(guarded)` layout uses it to render the
  shell or the "You do not administer this gateway" explanation without redirecting.
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
  strong weight. The same list has three drawings, chosen by the width of the
  window ([The collapsed form and the phone bar](#the-collapsed-form-and-the-phone-bar)).
- **Which entry is current** is `sectionOf(pathname)` (`nav.ts`, pure): the
  home is its own path only; any other entry is its path and what is under
  it; and the pages that have no entry belong to one — `/admin/**` and
  `/design` to Settings (connected apps are under `/settings` itself). Outside the
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

#### The collapsed form and the phone bar

**The collapsed form** is CSS only (`shell.module.css`). Under 1024 px the
navigation is a 56 px rail of icons: the labels and the person's name are
visually hidden, still read by assistive technology, and each link carries its
label as `title`.

**A phone** (640 px and under) has no pointer to hover an icon with, so an
icon alone would say nothing: the navigation is a **bar fixed at the bottom of
the screen, an icon and a word per entry**
([ADR](../decisions/interface-fixes-after-the-visual-review.md)).

- The bar holds the four places a person goes to every day — `PHONE_BAR` in
  `nav.ts`: Now, Waiting for you, Missions, Accounts — and **More**
  (`NAV_MORE`, `data-testid="nav-more"`), a button that opens the other
  entries (Activity, Reference, Settings) in a sheet above the bar
  (`data-testid="nav-sheet"`). Seven entries stay seven: none is removed on a
  phone. The sheet closes on Escape (the focus returns to the button), on a
  press outside, and when the path changes. While it is closed its list is
  empty, so every entry is in the document once.
- A label too long for a fifth of the screen is drawn in a short form
  (`NAV_SHORT`: "Waiting" for "Waiting for you"); the link keeps its full
  name for assistive technology and as its `title`. The count of what waits
  stays on its entry.
- "More" is marked as the current entry when the page is under one of the
  entries it holds.
- The top of the screen keeps who and where: the brand with its name, the
  person, the theme toggle. The page ends above the bar
  (`padding-bottom` of the main column, with the safe-area inset).

**The page column.** `main.page` is 1120 px wide at most, with 44 px of side
padding. A page chooses another measure through its `PageHeader`
(`width="narrow"` 860 px, `width="wide"` 1240 px), which the shell reads with
`:has([data-page-width])`. A page written before the redesign that holds a
wide table asks for the wide measure from its own style sheet
(`main:has(.wide)` in `activity.module.css`).

**Settings.** `settingsNav(administrator)` (`settings-nav.ts`, pure) gives the
groups of the local navigation: **You** — Preferences (`/settings`), Connected
apps (`/settings/connected-apps`) — and, for an administrator
(`isOperatorPrincipal(principal)`, `components/auth/principal.ts`),
**Administration** — Setup (`/admin`), Sign-in (`/admin/identity-provider`),
Company apps (`/admin/provider-apps`), People (`/admin/users`), Teams
(`/admin/groups`), Accounts without owner (`/admin/connections`), Telemetry,
Registered apps (`/admin/oauth-clients`), in the order a gateway is set up.
No label is used for two things. `SettingsFrame({ principal, children })`
renders it beside its children (`SubNavFrame` + `SubNav`); the
`admin/(guarded)` layout (through `AdminShell`), the layout of connected
apps and the Settings page use it. Each page under it opens with a
`PageHeader` whose title is its entry (`SETTINGS_PAGES` in
`lib/vocabulary.ts`) and shares `components/settings/settings.module.css`;
what each one shows is in the handbook of its feature
([authentication](authentication.md): Setup, Sign-in, People;
[connections](connections.md): Company apps; [authority](authority.md): Teams,
Accounts without owner; [telemetry](telemetry.md);
[management-door](management-door.md): Connected apps, Registered apps).

`/settings` (`(app)/settings/page.tsx`, `requirePrincipal()`) holds the theme
as three named options (`ThemeChoiceControl`, `data-testid="settings-theme"`)
and a link to connected apps, and for an administrator a link to
Administration and to the interface reference
(`data-testid="settings-interface-reference"`). The interface reference
(`/design`) is a component gallery, a tool of whoever maintains the gateway:
the page stays open to every session by its address, and is listed for
administrators only.

On a phone the local navigation (`SubNav`) is one labelled row of chips per
group — the label above, each entry a target a finger can hit — instead of a
wrapping line of words.

`BuildFooter` (server component) is one quiet line where the page ends:
`Vaubaan Gateway <version> · <commit>`, the build stamps of
`server/config/build-info.ts` — the values `/healthz` answers and telemetry
reports as `gateway_version`; `dev` for an unstamped build. Every page a human
reads carries it:

- the shell, for the application and for Administration — the "You do not
  administer this gateway" explanation of the Administration layout is drawn
  inside the same shell (`AppShell`, the empty-state component, "Go to Now"):
  a person who opens `/admin` without administering keeps their navigation,
  like on "Not found" (`data-testid="not-administrator"`);
- `/login`, `/admin/bootstrap` (outside every layout) and the root
  `not-found.tsx`, through the `footer` of `AuthPage`;
- the pages of the authorization endpoint — the consent screen and its
  message pages. They are HTML documents built as strings by
  `server/oauth-as/pages.ts`, not React, over the shared document of
  `server/http/document.ts`
  ([Self-contained documents](#self-contained-documents--serverhttpdocumentts)):
  `buildFooter(build)` there writes the same line with the same test ids
  ([management-door](management-door.md)).

`data-testid`: `build-footer`, `gateway-version`, `gateway-commit`. The
version has one source, the root `package.json`
([coding workflow, "One version"](../workflow/coding-workflow.md#one-version)).

Seeing a link is not the authorisation. Each page decides for its principal
with a session helper: the Accounts, Shared with you, Missions, Waiting for
you and Connected apps pages render `NeedsUser` for the bootstrap operator
(`currentUser()`); `/activity`, `/reference/**`, `/settings` and `/design` are
open to every session (`requirePrincipal()`), and `/activity` widens what it
shows for an administrator.

## The home — Now

`(app)/page.tsx` is the one home (spec §4.2): what is waiting for me, what is
running, what just happened. It calls `currentUser()` (the bootstrap operator
reads `NeedsUser`), reads **one model** and decides nothing:
`readNow(nowDepsOf(root), { user, groups })` (`server/now/now-reader.ts`).

**The read model** composes reads that already decide who sees what, and adds
no rule of its own.

| Field             | From                                                                          | Holds                                                                                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waiting`         | `RequestService.waiting` ([requests](requests.md))                            | the open requests of the missions the person created, each with who asked and what is left; never the arguments of a call                                                                                                                                                                                     |
| `running`         | `MissionService.list`, then per mission the tokens, the session and the audit | the active missions the person can read, the most recently active first (`byLastActivity`): services, key holders (theirs first), the connected app that created it, `nearest` (the permission closest to its limit, `nearestLimit`), `limits_reached`, `open_requests`, `last_activity_at`, `calls_last_day` |
| `stopped`         | the same list                                                                 | at most `STOPPED_SHOWN` (3) missions that do not run any more — expired, revoked, orphaned — with since when                                                                                                                                                                                                  |
| `totals`          | `AuditRepo.tokenHolderActivity` per mission; `ConnectionService.listFor`      | missions, stopped, calls in the last 24 hours, refusals in the last hour, accounts the person owns and how many must be reconnected                                                                                                                                                                           |
| `first_run`       | the same list                                                                 | the person created no mission                                                                                                                                                                                                                                                                                 |
| `shared_accounts` | `ShareService.received`                                                       | the accounts someone gave access to: service, owner, how many permissions (the union when several shares cover one account)                                                                                                                                                                                   |
| `shared_missions` | the same list                                                                 | the missions shared with the person as a teammate, and whether they hold a key of each                                                                                                                                                                                                                        |

A teammate does not read the requests of a mission shared with them; they may
know that it waits (`open_requests`, counted from `listForMission`). Counts
are windows of time, not calendar days: the server does not know the
reader's time zone. The cost is a handful of indexed reads per mission the
person can read, no scan. `readSetup(setupDepsOf(root))` (`server/now/setup.ts`)
is the checklist an administrator reads on a first run: the host of the
identity provider, the services whose company app is registered or missing
(`ProviderAppsService.list`, `needsApp`), and whether telemetry was decided.

**The page has three forms** (`(app)/_now/`; style guide §1.1):

- **Something waits** (`NowView`): `Waiting for you` (`now-waiting`: an
  `AnswerRow` per request — the permission or "… reached its daily limit",
  who and on which mission, the tool, the room left), `Running now`
  (`now-running`: a `RunRow` per mission; the one figure is a `Meter` that
  draws itself only near a limit, "Limit reached", or — for a teammate —
  "waiting for Alice's yes"), a line naming what does not run any more, and
  the totals as a `SummaryLine` (`now-totals`). The oldest request carries
  the one primary action; "New mission" steps down to a secondary button.
  "Show details" (a `DetailScope`, `now:running`) adds a line per mission:
  the calls of the last 24 hours and the nearest limit as a figure.
- **Nothing waits** (`now-nothing`): one sentence — "Nothing needs you. 4
  missions are running." — and three links; "New mission" is the primary
  action. What is running is one click away (`Disclosure`, `now:essential`)
  and the page remembers the click.
- **First run** (`FirstRun`, when `first_run` and nothing waits): a welcome,
  one paragraph, the model in five nodes (`ModelDiagram`, `FIRST_RUN.model`),
  then three steps (`now-steps`): an account (done when the person owns one
  or was given access to one), the first mission, the kit. An administrator
  reads the setup list first (`now-setup`). What was shared is listed
  (`now-shared-missions`) with "Get my key". One accent on the page: what is
  left to set up, else the next step.

**A yes is never given from the home.** The row of an approval leads to its
request ("Review"), where the exact call and its arguments are shown; a
refusal runs nothing and is a plain form post from the row. The row of a
limit leads to its request ("Answer"). ADR
[now-and-waiting-pages](../decisions/now-and-waiting-pages.md).

The date under the title (`Today`, client) is the reader's own, written by
`formatToday` of `lib/dates` ("Wednesday 14 October, 02:02"); the server
renders the UTC instant, says "UTC", and the browser replaces it after
hydration.

**The head of an approval** on the home, in the inbox and on the mission is
what the agent wants to do — "Merge a pull request · acme-org/app"
(`CallHeadline`, [requests](requests.md), "What a page heads a request with")
— and the line under it names the permission the call needs. Who asks reads
agent first, then whose key it holds ("release-bot, with your key"): `asker`
of `lib/vocabulary.ts`.

## Pages outside the shell

`components/auth/AuthPage.tsx` is the frame of a page that has no shell: one
narrow column in the middle of the window — the mark, the product and the
host of the gateway (`instance`), then the page — and the build line the page
passes as `footer`. `AuthHeading` is its title and its one sentence. It reads
the tokens, so it follows the theme like any page, and has no hook: `error.tsx`
(a client component) uses it too.

| Page                               | Says                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/login`                           | "Sign in to `<host>`" and one plain link per sign-in provider ("Continue with <name>"), the install-token link while it is valid; the closed error codes of a failed attempt; a signed-in person is sent to the home, and the sign-in it starts returns there ([authentication](authentication.md), "Pages") |
| `/admin/bootstrap`                 | "Set up this gateway": the bootstrap token form while it is active, otherwise that it no longer works ([authentication](authentication.md))                                                                                                                                                                  |
| `app/not-found.tsx`                | an address that matches no page, and a page of Administration asked by someone who does not administer: "This page does not exist", the way to the home, nothing about what exists                                                                                                                           |
| `(app)/not-found.tsx`              | `notFound()` thrown by a page of the application — an unknown mission, account or service, or one that is not the reader's: the shell stays, the title is "Not found" (`data-testid="not-found"`)                                                                                                            |
| `(app)/error.tsx`, `app/error.tsx` | a page failed while rendering: "This page could not be shown", "Try again" (`reset`), and the digest the server logged the error under as a reference to quote (`page-error`, `error-reference`)                                                                                                             |
| `app/global-error.tsx`             | the root layout itself failed: it replaces the document, imports the style sheet and reads no session and no theme cookie                                                                                                                                                                                    |

## Self-contained documents — `server/http/document.ts`

Some pages are answered by a handler itself, as an HTML string, under a
content policy that loads nothing: the consent screen of the authorization
endpoint and its messages ([management-door](management-door.md)), and the
refusals of the forwarded request URL ([requests](requests.md)). They cannot
read the style sheet of the application, so `document.ts` (host-agnostic,
pure) repeats the tokens they need, value for value, in both themes
(`DOCUMENT_TOKENS`), and builds the document:

- `htmlDocument({ title, body, footer?, theme?, nonce? })` — the brand, then
  `body` inside one column with the rhythm of `AuthPage`; `messageDocument`
  is the document of one title and one sentence;
- `documentThemeOf(headers)` — the theme the person chose in the application,
  from the `vaubaan_theme` cookie; `null` follows the system
  (`prefers-color-scheme`). The handler passes it, so the document arrives in
  the right theme with no script;
- `escapeHtml` — the caller escapes what it puts in `body`.

`src/server/http/document.test.ts` keeps every value equal to
`styles/tokens.css`, refuses any colour that is not one of them, and checks
that a document carries no script and no external resource.

## Words — `lib/vocabulary.ts`

The words a person reads are in one file, pure and browser-safe, imported by
the shell, the components and the pages (ADR
[interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md)).
The protocol keeps its names; this file is the bridge, keyed by them.

| Export                                                                               | Holds                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROUTES`, `NAV`, `NAV_ORDER`, `NavKey`                                               | the page paths and the seven entries, in order                                                                                                                                     |
| `TERMS`, `count(n, term)`, `formatNumber`, `capitalize`                              | one word per thing, keyed by the spec's name (`TERMS.connection.one` is "account"); "26 permissions", "1,212 calls"                                                                |
| `PAGES`, `ACTIONS`, `SECTIONS`                                                       | page titles and their one-sentence ledes; the labels of actions ("Replace key", "Give access"); shared section headings                                                            |
| `GATE_WORDS`, `gateWordOf(gate)`, `ALLOW_WORDS`, `asksFirst(name)`                   | "runs freely", "ask me first", "not included"; "Can", "Asks you first" / "Asks Alice first", "Cannot", "Limits today"                                                              |
| `SEVERITY_LABEL`, `WHY_LABELS`, `WHY_ORDER`, `whyValue(axis, v)`                     | the six axes of the risk model in words (Undo, Blast radius, Data, Cost, Visible to, Lasts) and their values                                                                       |
| `LIMIT_WORDS`, `usage`, `roomLeft`, `perPeriod`, `limitsReset`                       | "1,860 / 3,000", "49 of 50 left today", "3,000 a day", "limits reset every day"                                                                                                    |
| `KEY_WORDS`, `keyOf(holder)`, `possessive`                                           | "your key", "Carol’s key", "the machine key nightly"                                                                                                                               |
| `ROLE_WORDS`, `qualifiers`, `ownership`, `accessGiven`, `mayAllow`                   | "· you · creator", "you own it with Platform", "access given by Bob · 12 of 17", "all 15"                                                                                          |
| `MISSION_STATES`, `ACCOUNT_STATES`, `REQUEST_STATES`, `DECISION_WORDS`               | a label and a tone per state, keyed by the protocol's state; the tone is `null` for the normal state                                                                               |
| `WAITING`, `waitingFor(name)`, `ASKED_FIRST`, `reachedLimit`, `running`              | the sentences of "Waiting for you"                                                                                                                                                 |
| `everyOf`, `periodNow`, `limitOf`, `missionReachedLimit`, `limitReachedOn`, `usedOf` | a limit said with its period, from a period length in seconds: "today", "its daily limit", "5,000 of 5,000"; "this period" for an unnamed length, "in all" when limits never reset |
| `until`, `agoPhrase`, `delay`, `asker`                                               | "in 13 h", "4 min ago", "10 minutes"; who asks: "Carol · codex", "You · codex", "machine key nightly", "An agent"                                                                  |
| `NOW`, `FIRST_RUN`, `ANSWERS`, `REQUEST_WORDS`                                       | the words of the home, of a first run (the model in five nodes, the steps), of the answers keyed by the protocol's resolution, and of a request's page                             |
| `ago(from, now)`                                                                     | "now", "4 min", "1 h", "yesterday", "4 d"                                                                                                                                          |
| `THEME_WORDS`                                                                        | System, Light, Dark                                                                                                                                                                |
| `MISSION_ACTIONS`, `MISSION_WORDS`                                                   | the acts and the sentences of the mission pages ("Stop the mission", "Generate my key", "Shown once. Lost it? …")                                                                  |
| `OPTIONAL_APP_WORDS`                                                                 | Company apps, for a service that also connects with a token: "not registered · optional", "The company app is optional for Railway", "Connect Railway with a token"                |
| `limitsResetEvery`, `limitColumn`, `usedColumn`, `periodWord`                        | a period in words, from its length in seconds: "limits reset every week", "Per week", "Used this week", "this week"                                                                |
| `shortDate`, `expiresOn`, `agoSentence`, `listed`                                    | "12 Nov" (UTC, the same on the server and in the browser), "expires 12 Nov", "4 min ago", "a, b and 3 more"                                                                        |

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

| Rule                                                           | Stated in                                                    | Read by the page as                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a revoked or unowned connection takes no owner act (spec §2.3) | `ownerActRefusal(connection)` (`connections/service.ts`)     | `ShareContext.unshareable` (the "Give access" dialog prints `SHARE_ERROR_MESSAGES[unshareable]`; the account page hides "Give access", the actions of each access row and "Reconnect") |
| the same, for a transfer                                       | `ConnectionService.transferTargets` returns no group         | the transfer of ownership is offered when a target is listed                                                                                                                           |
| the gates of a revoked or orphaned mission are not edited      | `gateEditBlockedBy(mission)` (`missions/mission-service.ts`) | `MissionDetail.gates_editable`                                                                                                                                                         |
| a group without member is not named owner                      | `ConnectionService.reassignTargets()`                        | the team list of Settings → Accounts without owner                                                                                                                                     |

`share`, `transfer`, the reconnection, `setGate` and `reassign` refuse on the
same functions, and `tests/integration/authority/rules-read-by-pages.test.ts`
asserts, on one state, what the reader says and what the act then answers.
The statuses a page still tests itself (`revoked`, `unowned` on the account
page) choose a note or a read-only field: what is displayed, not what is
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

| Export                              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Rows`, `Row`                       | a `<ul>` of quiet rows: `lead` (a mark), `title` (a link with `href`), `description`, `aside` (at most one thing), `end` (an action or a short fact), `muted`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DataTable`, `Column`               | a typed table: `columns` (`id`, `header`, `cell`, `align`, `nowrap`, `width`, `detail`), `rows` or `groups`, `rowKey`, a required `caption` (not drawn), `actions` (shown on hover and on focus; always drawn on a device that cannot hover and in a phone-sized window), `narrow` (`stack` by default, `scroll`), `rowTone` (`bad`, `warn`, `quiet`), `rowDetail`, `headless`, `density`, `empty`. **Five columns by default, seven with details**: `checkColumnBudget` throws beyond that; `columnBudget={6}` is the documented exception of the activity record |
| `Meter`, `meterState`, `NEAR_LIMIT` | `used`, `limit`, `threshold` (a share of the limit, default 0.6): below it a dash (`placeholder="none"` renders nothing) that still says the figure to assistive technology; near it an amber bar; at the limit a red one and "Limit reached". `threshold={0}` always draws. `format="percent"`, `label`                                                                                                                                                                                                                                                           |

**A table on a phone.** Five columns in 390 px wrap word by word, so under
641 px a `DataTable` draws each row as a block (`.stack` in
`Table.module.css`): the first cell is the title of the row, every other cell
is a line — the name of its column in the quiet ink (`data-label`, the
`header` when it is text, or the column's `label`; `label: null` draws the
value alone), then the value. The head leaves the drawing and stays in the
document; the roles (`table`, `row`, `cell`, `columnheader`) are written out
so that the table stays one for assistive technology whatever its drawing.
The actions of a row are always drawn there: nothing on a phone depends on
hovering. A tinted row is tinted as a whole. `narrow="scroll"` keeps the grid
and scrolls it inside its own box; nothing uses it today. The preset
comparison of the reference (a plain `<table>`, `reference.module.css`) keeps
its grid and scrolls inside its box.

**The quiet ink on a tint.** `--ink-3` on `--bad-soft` is 4.48:1, under AA. A
tinted surface — an exception row of a table, a `Callout`, the one filled box
(`AnswerRow boxed`) — redefines `--ink-3` as `--ink-2` for everything it
holds, so "quiet" stays readable there without each component knowing where
it is drawn. `design-tokens.test.ts` checks `--ink` and `--ink-2` on the four
tints in both themes.

**Marks**

| Export                                         | What it is                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StatusMark`, `Dot`, `Tag`, `EnvTag`           | a pill with a dot for an exception (`tone`: `neutral`, `info`, `ok`, `warn`, `bad`); the dot alone; a squared tag for a fact that is not a state; an environment label (`null` → "no label", dashed)                                  |
| `BadgeTone`, `toneOfBadge`                     | the tone names of the first interface (`success`, `warning`, `danger`) and their mapping to the new ones; `Callout` still accepts them                                                                                                |
| `Avatar`, `AvatarStack`, `KeyHolder`           | a person (round), a machine key (`kind="machine"`: dashed square, no hue), a team; three sizes; the hue comes from the name (`hueOf`), the letters from `initialsOf`; the name and its qualifiers                                     |
| `ServiceMark`, `KeyMark`, `AgentLabel`, `Mono` | the two letters of a service (from its display name, never from a list of services); a masked key in mono; the label an agent gave itself; an identifier in mono that wraps between its words                                         |
| `SeverityChip`, `GateMark`, `WhyCells`         | one severity word; "runs freely" / "ask me first" / "not included" with a dot; the six cells of the risk model in words                                                                                                               |
| `Icon`, `IconName`                             | sixteen-pixel line icons on a 24-unit grid, drawn in `Icon.tsx`: the seven of the navigation, `search`, `sun`, `moon`, `system`, `check`, `cross`, `alert`, `info`, `key`, `copy`, `chevron`, `more`, `signout`; always `aria-hidden` |

**Permissions, answers, states**

| Export                                                                                                      | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PermissionTable`, `PermissionGroup`, `PermissionRow`                                                       | client. The table chooses its columns by `variant`: `editor` (tick, permission, risk, per day, per minute, ask me first), `read`, `usage` (used today, per minute, gate), `pick` (tick, permission, risk). A row takes `label`, `id` (mono, under the label), `severity`, `included`, `select`, `usage`, `perDay`, `perMinute`, `gate`, `gateControl`, `tag`, and `why` (`reason`, `cells`, `referenceHref`, `tools`), closed behind "why?" |
| `AllowSummary`                                                                                              | Can / Asks you first / Cannot, and "Limits today" when given; the asking line is left out when nothing asks; `asksLabel` for someone else's mission; `compact` in the rail                                                                                                                                                                                                                                                                  |
| `AnswerList`, `AnswerRow`                                                                                   | what waits for the person: `who`, `title`, `age`, `description`, `answers`; `boxed` is the one filled (amber) box of a page                                                                                                                                                                                                                                                                                                                 |
| `RunList`, `RunRow`                                                                                         | what is running, one line per mission in four columns: `title` (a link), `facts`, `holders` (an `AvatarStack`), `figure` (a `Meter` or a `StatusMark`: one thing), `last`; `detail` is a second line shown while the surrounding `DetailScope` is open                                                                                                                                                                                      |
| `InboxFrame`, `InboxList`, `InboxItem`                                                                      | the inbox: a list of links (`who`, `title`, `context`, `meta`; `current` is a fill and `aria-current`) and one item open beside it; one column under 900 px                                                                                                                                                                                                                                                                                 |
| `RequestStatement`, `CallBox`, `ArgList`, `FactColumns`, `DecideBar`, `ContextColumns`, `Feed`, `FeedEvent` | one open request: who asks then the statement at the size of a title (with the `status` of a closed one); "Exactly what it sent" (the one quiet fill; each argument by its name, never truncated); labelled facts side by side; the answers with one quieter `aside`; context in two columns; a short timeline whose mark carries its word                                                                                                  |
| `EmptyState`, `Lede`, `ModelDiagram`, `StepMark`, `CheckMark`, `Skeleton`                                   | one sentence and one action; the paragraph and the drawn model of a first run; the lead of a step row and of a checklist row; the shape of what is loading                                                                                                                                                                                                                                                                                  |
| `Callout`                                                                                                   | a note with an optional `title`, a `tone`, an optional `action`; `role="note"`; tone `ok` is drawn in the accent (green is for checklist ticks only)                                                                                                                                                                                                                                                                                        |

**Actions, overlays, details, forms**

| Export                                                                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`, `ButtonLink`                                                     | `variant` (`primary` — the accent —, `secondary`, `ghost`, `danger`), `size` (`sm` 26 px, `md` 30 px, `lg` 36 px; the two small ones answer on 32 px), `loading`. `ButtonLink` is a link with the same look (`external` for a plain `<a>`)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Dialog`, `DialogPanel`, `ConfirmDialog`, `OptionCard`, `DangerConfirm`    | client. A native `<dialog>` opened with `showModal()`: the browser keeps the focus inside, Escape and the backdrop call `onClose` (not while `dismissible` is false). Never taller than the window: its top margin (`--dialog-top`: 96 px, 60 px when wide, 24 px in a window under 820 px high, 16 px on a phone) and the same room under it are taken off `max-height`, and the body scrolls between a head and a foot that stay in view — a page adds no height rule of its own. `ConfirmDialog` takes a required `consequence`, optional `options` (radio cards), a `confirmLabel` named after the act, `tone`, `busy`, `error`, `hint`. `DangerConfirm` asks for a typed `phrase` |
| `ToastProvider`, `useToast`, `ToastCard`                                   | client. Mounted once by the shell; `useToast()` returns `toast({ title, description?, tone? })`; announced politely; leaves after five seconds unless it is a failure; an `ok` check is drawn in the accent, never green                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Disclosure`, `DetailScope`, `DetailToggle`, `DetailOnly`, `useRemembered` | client. Details on demand, remembered in `localStorage` under `vaubaan:open:<id>` (`id` names the page and the region). A scope flips `data-details` on a wrapper: the `detail` columns of a `DataTable` and any `DetailOnly` block inside follow it, even when rendered by the server                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TabList`, `TabPanel`, `TabItem`                                           | client. Tabs with the ARIA roles and keyboard; the state belongs to the caller                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PickGrid`, `PickCard`                                                     | a handful of choices of the same kind as quiet bordered cards — a mark, a name, one line that says how; `unavailable` is dashed and says why. The one exception to "rows, not cards": the cards are the action (the services an account can be connected to)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ConfirmSubmit`                                                            | client. A button whose act is a plain form post, asked first: it opens a `ConfirmDialog` with a required `consequence` and submits the form (`action`, hidden `fields`) on confirmation. For an act that stops, removes or hands over something                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Segmented`, `FilterChips`, `SearchField`, `FilterOption`                  | client. One choice among a few; facets that add up; a search field. An option with `href` is a link (the filter lives in the URL), otherwise a button                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`      | `Field` takes `label`, `htmlFor`, `shape` (the expected shape, said in the label), `optional`, `hint`, `error`; it gives its control `aria-describedby` and, with an error, `aria-invalid`. Controls take `size="sm"` and `mono`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Code`, `CodeBlock`, `CodeTone`, `CopyButton`                              | inline code; a dark block with a Copy button that copies `copy` (or the text when it is a plain string) — on a phone the button sits above the block, not over its first line; a keyword, a string or a comment inside a block; a copy button on its own                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Labels are bound to their controls.** A `Field` that holds one control
takes `htmlFor`, the `id` of that control, and renders a real `<label for>`.
A `Field` that holds several controls (the claim mapping of the identity
provider) takes no `htmlFor`: its wrapper is a `role="group"` named by the
label, and each control carries its own `aria-label`. Ids must be unique on
the page: `CredentialFieldInputs` (`components/connections/parts.tsx`) takes an
`idPrefix`; Administration → Company apps passes `provider-app-<provider id>`
because it renders one list per provider.

**Added with the mission pages**

| Export                                    | What it is                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MoreMenu`, `MenuItem`                    | client. The rest of a page's actions behind "···": a button (`aria-haspopup="menu"`) and a panel of `role="menuitem"` — a button, or a link with `href`; `danger` for an act that stops something, `disabled`, a `note`. Escape, a click outside and a choice close it; the arrows move |
| `ChoiceRow`, `ChoiceChip`                 | one choice among a few, as radio chips in a `fieldset` named by `legend`; a chip takes a `hint` (a short fact) and `unavailable` (why it cannot be chosen: it is then dashed, disabled, and the reason replaces the hint)                                                               |
| `SecretBox`                               | a key, whole, once: the accent box with the key in mono and a button that copies it                                                                                                                                                                                                     |
| `FormWithRail`, `FormStep`, `FormColumns` | a form in numbered steps with a rail whose head and foot (the action) stay in view (an `aside`; after the steps under 1100 px); a step is its number, its `h2`, one short `hint`; a few fields of a step side by side                                                                   |

`PermissionTable` takes `labels` (`limit`, `usage`) for a mission whose limits
do not reset every day: "Per week" and "Used this week" instead of "Per day"
and "Used today" (`limitColumn`, `usedColumn` in `lib/vocabulary.ts`).

**Server or client.** Everything not marked "client" above has no hook and
renders in server and client components alike. A client component takes
rendered nodes from a server page (`select`, `usage`, `answers`), never a
function.

### The gallery — `/design`

`(app)/design/` renders every component in every state: `page.tsx`
(`requirePrincipal()`, any session) and a client gallery (`gallery.tsx`,
six files of sections — `sections-waiting.tsx` holds the running list, the
inbox and the open request, `sections-missions.tsx` the components added with
the mission pages —, `specimen.tsx`). A `Specimen` draws its content twice,
on an island with `data-theme="light"` and on one with `data-theme="dark"`, so
both themes are compared on one screen whatever the theme of the page. Every
value on it is invented. It is linked from Settings, and it is what a page is
compared with in review. Adding a component, a variant or a state means adding
its specimen.

### Removed with the last page that used them

The primitives of the first interface are gone: `Slug`, `Glyph`, `KindLegend`
and the list of kinds (`kinds.ts`), `Help`, the `Badge` label, `Banner`, the
bare `Table` elements, and the "Kept for older pages" section of the gallery.
A page prints an identifier with `Mono` or `KeyMark` and says the kind in
words, gives one sentence of lede and puts the rest behind a `Disclosure`,
and builds a table with `DataTable`. `Callout` takes no `icon` any more: its
mark follows its tone.

### Display helpers

Shared by the pages that used to carry a copy each (how a risk was explained
before the redesign — `components/risk/` — is deleted: a permission is a
`PermissionRow`, a `PermissionTable`, a `PermissionList`
(`components/connections/`) or its id in `Mono`):

- `app/(app)/missions/message-of.ts`: `messageOf(body, status)`, the `message`
  of a JSON refusal of the mission API or "The instance answered `<status>`."
  (the "ask me first" switch, the acts of a mission page, the mission form);
- `components/auth/principal.ts`: `isOperatorPrincipal(principal)`
  ([The shell](#the-shell--componentsshell)).

**Dates: one form, one helper.** `lib/dates.ts` (pure, no import) is the one
place a date becomes text, and the text does not depend on the reader's
locale ([ADR](../decisions/interface-fixes-after-the-visual-review.md)):

| Function                         | Writes                                           |
| -------------------------------- | ------------------------------------------------ |
| `formatDay(at, { zone, now })`   | "14 Oct"; "14 Oct 2025" when it is not this year |
| `formatClock(at, { seconds })`   | "01:48" on 24 hours; "01:48:59"                  |
| `formatDayTime(at, { seconds })` | "14 Oct, 01:48"; "14 Oct, 01:48:59"              |
| `formatToday(at)`                | "Wednesday 14 October, 02:02" (the home, once)   |

No page calls `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` or
`Intl.DateTimeFormat` (a test of `lib/dates.test.ts` reads the sources): a
browser set to US English would print "10/14/2026, 1:48:59 AM" beside a page
that says "14 Oct". The locale never changes the text; the time zone does.
The server does not know the reader's zone, so it writes UTC (`zone: 'utc'`,
the default) and the client components replace it with the reader's own after
hydration (`zone: 'local'`), without a hydration mismatch:

- `components/LocalDate.tsx` — a `<time>` with the exact instant as `dateTime`
  and `title`: "14 Oct, 01:48", `dateOnly` "14 Oct", `seconds` for a timeline
  read line by line (the last events of a mission). The mission pages, the
  request pages, Connected apps and the Administration pages use it;
- `components/RelativeTime.tsx` — a server `<time>` said relative to the
  page's `now` (`agoSentence`, with an optional word before it: "created 2 h
  ago"), the exact instant as `dateTime` and its day and clock in UTC as
  `title` ("15 Oct, 13:45 UTC"). The missions list and the mission header use
  it, so that two missions of the same name are told apart;
- `waiting/local-time.tsx` (`LocalTime`: "10:58"), `activity/when.tsx`
  (`When`: the clock to the second, the day under it), `_now/today.tsx`.

A sentence built on the server prints a short day in UTC (`shortDate` of
`lib/vocabulary.ts`, which is `formatDay`: "14 Sep") or how long ago (`ago`,
`agoSentence`, `until`). The native date fields of the activity filters are
the browser's own control and show the browser's own placeholder.

The other shared components belong to one feature and are described in its
handbook:

- `components/connections/parts.tsx` (server): `AccountState({ status })` (a
  mark only for an exception: "Needs reconnecting", "Needs an owner"; a plain
  word otherwise), `ExperimentalBadge`, `NoticeBanner({ notice })` for the
  one-time note a redirect left, `credentialKindLabel(kind)` and
  `CredentialFieldInputs` with `credentialFieldId`, which says the shape a
  field expects in its label (`shape.ts`: `shapeOfPattern`)
  ([connections](connections.md));
- `components/connections/ServicePicker.tsx` (the services an account can be
  connected to, as `PickCard`s) and `PermissionList.tsx` (the explicit list
  behind a count such as "12 of 17");
- `components/connections/RevokeConnection.tsx` (client): "Disconnect this
  account…", a `DangerConfirm` whose phrase is the name of the account, which
  says how many missions stop and whose confirmation submits a plain POST
  form; `CloseOrphanedMission.tsx` (client): "Close" on a mission that
  stopped for want of an owner, typed too;
- `components/telemetry/ValidationBadge.tsx`: the community validation status
  as a quiet tag (the details of an account, the reference), nothing when
  there is no status ([telemetry](telemetry.md));
- `app/(app)/missions/mission-view.ts`: `missionMark(state, waiting)`, the
  state of a mission in words, with a tone only for an exception
  ([missions](missions.md), "The mission pages");
- `components/auth/AuthPage.tsx`: `AuthPage` and `AuthHeading`, the frame of a
  page outside the shell ([Pages outside the shell](#pages-outside-the-shell)).

## The reference — `/reference`

Documentation of the gateway inside the gateway (spec §4.2 "Providers"): what
each shipped plugin connects to and what a mission can hold on it. Both pages
call `requirePrincipal()`: any session reads them, the bootstrap operator
included; they show no account, no mission and no credential. The structural
test of the surface (`tests/unit/app/app-guard.test.ts`) lists them with
`/activity` among the pages open to any session. The pages say **service** for
a provider, **permission** for a risk and **part** for a plane; ids, tool
names and patterns are printed as the protocol spells them, in mono.

Everything is generated from the plugin registry by
`src/server/providers/reference.ts` (pure, no IO); no service has a
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
| `riskPlanesOf(model, catalog)`         | `planes.ts`: per catalog entry its planes, or `null` for a model with one plane; what the plane filter of the permission editor of "New mission" reads                   |

A `RiskReference` also names the presets that include it (`presets`: id, label,
anchor), the tools the plugin declares for it (`declared_tools`, from
`tokenHandouts`) and its `planes`; a `ToolReference` has its `planes`; the
reference has `plane_filters` (slug, description, counts), empty when the
model has one plane.

**The frame** (`reference/frame.tsx`, `ReferenceFrame`): the `PageHeader` of
the place ("Reference", on the wide measure) and the services as a local
navigation beside the content (`SubNav`: "All services", then one entry per
plugin with its `ServiceMark`).

**The index** (`reference/page.tsx`) is a quiet list, one row per service: its
mark, its name (a link; "experimental" and the community validation tag where
they apply), the plugin's one-line description, and "15 permissions · 3 presets
· 26 tools" at the end (`catalogSize`). `data-testid="provider-<id>"`.

**`/reference/<id>`** is rendered by the server (`[id]/page.tsx`) down to the
tabs, then by a client body (`[id]/service-view.tsx`, `ServiceView`):

- **Header** — a `PageHeader` at level 2 (the `h1` stays "Reference"): the
  mark, the name, "experimental", and the plugin's `summary` as the lede
  (plain words: what an account is, what a resource is, where the environment
  comes from — [plugin-sdk](plugin-sdk.md)). Under it one line of counts and
  how an account connects, and "About this service" (a `Disclosure`): what it
  connects to, the credential, the environments and where they come from, the
  plugin and catalog versions with the maintainer notes (`docsUrl`), the
  community validation tag.
- **Tabs** (`TabList`, sticky under the top of the window) — one section in
  view at a time: **Permissions** (the default), **Tools**, **How it is
  modelled**; the first two carry a count that follows the filters. Selecting
  a tab writes its fragment (`#permissions`, `#tools`, `#data-model`).
- **Filters**, under the tabs — a `SearchField` that narrows the permissions
  (label, id, reason, declared tools) or the tools (name, description); and,
  only when the model has several planes (today Supabase), a `Segmented`
  "part of the service": "All", one per plane, and `other` when something is
  filed there. It slices every tab at once. `data-testid="plane-control"`.
- **How to read this page** — closed by default, remembered
  (`useRemembered('reference:how-to-read')`; the fragment `#legend` opens it):
  what a permission, a preset and "risk" are, the six words behind a severity
  with the question each answers (`WhyCells`), permissions that exist once per
  environment, "anything not named" and "being retired", and how parts are
  read when there are several.

The three sections, one file each beside the page:

1. **Permissions** (`permissions.tsx`, `PermissionComparison`) — one table,
   the permissions against the presets. Columns: the permission, its severity
   (`SeverityChip` of its most severe variant), then one per preset
   (`<th id="preset-<id>">`: its name, a link to its own column, and what it
   holds — "10 · 2 ask", `presetHolds`). Rows are grouped by kind
   (`PERMISSION_KINDS`: reads, writes, writes that cannot be undone); a row
   (`<tr id="risk-<id>">`) is what the entry allows in words, its id in mono,
   the environments it exists in, the tags "anything not named", "being
   retired", "hands a read-only token" / "hands a write token", one line of
   reason, and "why?". A cell is the limit the preset gives the entry — the
   quota, with "asks first" when the gate is `approval`, once per environment
   for an entry held per environment (the per-minute rate is the cell's
   `title`) — or a dash ("not included" to assistive technology).
   "why?" unfolds the entry under its row: the whole reason; the six words of
   its vector (`WhyCells`; one set per environment when an override changes
   it); the token hand-out note when it hands one; whether it is held once or
   once per environment, with the explicit id of each; what it covers — each
   pattern in words with the pattern after it; the tools the plugin declares
   for it; its limits in each preset that includes it (per period, per minute,
   runs freely or ask me first); the plugin's rate ceiling; the notes of the
   fallback and of a deprecated entry with its replacement. "Unfold every
   why" opens the list. An entry is listed once, under the kind of its most
   severe variant, so its anchor is unique. The table has a fixed layout: the
   presets and the severity keep their width, the permission takes the rest.
   Fifteen entries, folded, measure about one and a half viewports at
   1280×800 (the browser test bounds it at 1.75).
   `data-testid`: `permission-comparison`, `preset-matrix`, `preset-<id>`,
   `risk-<id>`, `cell-<preset id>-<risk id>`.
2. **Tools** (`tools.tsx`, `ToolList`) — a `DataTable`: the name in mono, the
   description, required and optional arguments, the part when the model has
   several, and the permissions. That last column reads "by arguments": a
   plugin classifies a call from its arguments and declares no table of the
   permissions of each tool; the page says so in one line and the rest
   (`TOOL_RISKS_NOTE`) is behind "Why no permission is listed per tool". The
   one exception is a tool the plugin declares in `tokenHandouts`
   ([plugin-sdk](plugin-sdk.md)): its row lists the declared ids under a
   **"hands a token to the agent"** tag, each a link to its row in
   Permissions, and a note above the table states `TOKEN_HANDOUT_NOTE` (spec
   §2.4): a token that can write is handed only after the creator approves the
   call, a read-only one may be handed without asking. Today that is
   `github__mint_install_token`, `github.mint-install-token-clone` (read-only,
   `auto` in the Developer preset) and `github.mint-install-token-push`
   (write, `approval`). `data-testid`: `tool-table`, a row is
   `tr[data-row="<tool name>"]`, `token-handout-note`.
3. **How it is modelled** (`data-model.tsx`, `DataModelSection`) — where the
   environment of a call comes from (`EnvironmentReference.source`: `none`
   when the catalog has no entry held per environment; otherwise `call` when
   the plugin declares `envOf`, and `resource-label` when it does not), then
   each plane as an outline with connectors: the thing, its cardinalities as
   small annotations, its description; what carries the environment is tagged.

**Fragments.** `ServiceView` reads the fragment when the page opens and on
every `hashchange` (`destinationOf`): a tab id selects its tab, and so do the
sections of the earlier page — `#presets` and `#risks` both select Permissions
(`TAB_ALIASES`); `#risk-<id>` selects Permissions, clears the text filter,
unfolds the entry, scrolls to it and marks it, and — when the part in view
does not show it — opens the entry's own; `#preset-<id>` selects Permissions
and marks the column. Links inside the page call the same function, so the
same link works twice in a row.

**Planes** (`server/providers/planes.ts`, pure and browser-safe). Nothing is
declared per risk or per tool, so the plane is read from what is declared and
never guessed: a risk belongs to the plane of the first entity of its pattern
that one plane alone declares (`project` is the root of every Supabase plane
and decides nothing); a tool, which declares no pattern, is filed under a plane
only when its name contains the name of such an entity, the longest name
winning. Whatever names none goes to `other` (`OTHER_PLANE`): on Supabase the
two catch-all risks (`read-data`, `uncategorized-write`) and the tools whose
name says nothing of a plane (`get_project`, `execute_sql`, the
`*_function` tools…). The same map feeds the plane filter of the permission editor
([missions](missions.md)).

**Git.** The page of the one plugin that declares a `gitRemote` ends with a
"Git" section (`reference-git`, `(app)/reference/[id]/page.tsx`): the remote
`<public_url>/git/<owner>/<repo>.git` with the key as the password, the two
audited git tools, each of the plugin's `abilities` with the permission it
needs (linked to its anchor), and what the gateway does not do (read the pack,
serve LFS, signed pushes, push options, `--atomic`). Handbook
[git-remote](git-remote.md).

`src/server/providers/links.ts` (browser-safe) is the only place that builds
those URLs and anchors: `providerPath`, `riskReferencePath`,
`presetReferencePath`, `sectionPath`, `riskAnchor`, `presetAnchor`. The
reference is linked from the account page (its details), the connect picker
and the connect form, the "Give access" dialog (each "why?"), the lists of
permissions on the accounts pages (`PermissionList`), the detail of an
activity line, mission creation, the mission page, the Waiting for you pages
and the session page.

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
- `build-footer.test.tsx` renders the footer (given stamps, the stamps of the
  build, `dev`), and `tests/unit/structural/version-single-source.test.ts`
  checks that the build stamps the version of the root `package.json`.

`guard-harness.ts` holds what the two guard files share (file discovery,
calling a page as a function, naming a redirect or a "not found").

`server/providers/planes.test.ts` covers the plane rules on a two-plane model
and on the shipped Supabase and GitHub plugins. Three helpers have a unit file
beside them: `components/auth/principal.test.ts`,
`app/(app)/missions/message-of.test.ts` and
`app/(app)/missions/new/form-state.test.ts`. The mission pages add two:
`app/(app)/missions/mission-view.test.ts` and
`app/(app)/missions/[id]/session/event-words.test.ts`
([missions](missions.md)).

- `now-and-waiting.test.tsx` renders the home, a first run and the page of a
  request to static markup over invented views: one `h1` and one primary
  action; the order a request is read in; the answers offered in each state;
  no yes and no argument on the home; the words of a limit, of a delay and of
  who asks.

`tests/integration/now/now.test.ts` holds the read models on the real root:
`readNow` for a creator, a teammate and a newcomer, its windows of time, and
`readSetup`; `src/server/now/derive.test.ts` the pure derivations.

In a browser, the Playwright suite `apps/gateway/tests/e2e/v5/`
(`npm run test:e2e:v5`, ten specs) exercises the rest. `now-and-entry.spec.ts`
holds the sign-in, a first run, "not found" inside and outside the shell and
the themed refusal of a forwarded URL; what waits and what runs on the home is
asserted by `exhaust-and-claim.spec.ts` and `approve-action.spec.ts`. `shell.spec.ts` is the
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
