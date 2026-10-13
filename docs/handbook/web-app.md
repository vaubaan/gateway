---
title: Web app — route map, layouts, shell, UI primitives
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/app/layout.tsx
  - apps/gateway/src/app/page.tsx
  - apps/gateway/src/app/(public)/layout.tsx
  - apps/gateway/src/app/(app)/layout.tsx
  - apps/gateway/src/app/admin/(guarded)/layout.tsx
  - apps/gateway/src/app/globals.css
  - apps/gateway/src/app/icon.svg
  - apps/gateway/src/app/apple-icon.png
  - apps/gateway/src/styles/tokens.css
  - apps/gateway/src/components/ui/
  - apps/gateway/src/components/shell/
  - apps/gateway/src/components/LocalDate.tsx
  - apps/gateway/src/components/auth/NeedsUser.tsx
  - apps/gateway/src/components/auth/PrincipalCard.tsx
  - apps/gateway/src/components/auth/principal.ts
  - apps/gateway/src/components/connections/
  - apps/gateway/src/components/risk/
  - apps/gateway/src/server/providers/
  - apps/gateway/src/app/(app)/providers/
  - apps/gateway/src/components/telemetry/ValidationBadge.tsx
  - apps/gateway/src/app/(app)/missions/message-of.ts
  - apps/gateway/src/app/(app)/missions/state-badge.tsx
  - apps/gateway/src/lib/auth/session.ts
  - apps/gateway/src/lib/connections/session.ts
  - apps/gateway/next.config.ts
  - apps/gateway/tests/unit/app/
---

# Web app — route map, layouts, shell, UI primitives

The frame of the human surface of the instance (spec
[vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2): which route is served by
which file, which handbook owns it, and what every page shares — root layout,
application bar, UI primitives. The behaviour of each page is in the handbook
of its feature. The v4 text that used to live here (Supabase sign-in,
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
  of the mission page (`GateControl`), the bootstrap kit view, the share form
  (`ShareForm`), `RevokeConnection`, `DangerConfirm`, `LocalDate`, the body of
  a provider's reference (`ProviderView` and its sections), the two parts of
  the bar that need the browser (`NavLinks`, `UserMenu`) and two primitives
  (`Help`, `TabList`). The only
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

| Route                                                                                                                       | File under `apps/gateway/src/app/`                                                                            | Handbook                              |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `/`                                                                                                                         | `page.tsx`                                                                                                    | [authentication](authentication.md)   |
| `/login`                                                                                                                    | `(public)/login/page.tsx`, `(public)/layout.tsx`                                                              | [authentication](authentication.md)   |
| `GET /auth/login`, `GET /auth/callback`                                                                                     | `auth/login/route.ts`, `auth/callback/route.ts`                                                               | [authentication](authentication.md)   |
| `POST /logout`                                                                                                              | `logout/route.ts`                                                                                             | [authentication](authentication.md)   |
| `/admin/bootstrap`, `POST /api/auth/bootstrap`                                                                              | `admin/bootstrap/page.tsx`, `api/auth/bootstrap/route.ts`                                                     | [authentication](authentication.md)   |
| `/admin`, `/admin/identity-provider`                                                                                        | `admin/(guarded)/page.tsx`, `admin/(guarded)/identity-provider/page.tsx`, `admin/(guarded)/layout.tsx`        | [authentication](authentication.md)   |
| `POST /api/admin/identity-provider`                                                                                         | `api/admin/identity-provider/route.ts`                                                                        | [authentication](authentication.md)   |
| `/admin/provider-apps`, `POST /admin/provider-apps/<provider>`                                                              | `admin/(guarded)/provider-apps/**`                                                                            | [connections](connections.md)         |
| `/admin/telemetry`, `POST /api/admin/telemetry`                                                                             | `admin/(guarded)/telemetry/page.tsx`, `api/admin/telemetry/route.ts`                                          | [telemetry](telemetry.md)             |
| `/connections`, `/connections/new`, `/connections/new/<provider>`, `/connections/<id>`                                      | `(app)/connections/**/page.tsx`                                                                               | [connections](connections.md)         |
| `/connections/<id>/share`, `POST /connections/<id>/shares`, `…/shares/<id>/revoke`, `…/transfer`                            | `(app)/connections/[id]/share/`, `shares/`, `transfer/`                                                       | [authority](authority.md)             |
| `/shares`                                                                                                                   | `(app)/shares/page.tsx`                                                                                       | [authority](authority.md)             |
| `/admin/users`, `POST /admin/users/<id>/deactivate`, `…/<id>/reactivate`                                                    | `admin/(guarded)/users/**`                                                                                    | [authentication](authentication.md)   |
| `/admin/groups`, `POST /admin/groups/create`, `…/<id>/members[/<userId>/remove]`                                            | `admin/(guarded)/groups/**`                                                                                   | [authority](authority.md)             |
| `/admin/connections`, `POST /admin/connections/<id>/reassign`                                                               | `admin/(guarded)/connections/**`                                                                              | [authority](authority.md)             |
| `POST /connections/connect/<provider>`, `GET /connections/callback/<provider>`                                              | `(app)/connections/connect/`, `(app)/connections/callback/`                                                   | [connections](connections.md)         |
| `POST /connections/<id>/discover`, `/revoke`, `/resources/<resourceId>`                                                     | `(app)/connections/[id]/**/route.ts`                                                                          | [connections](connections.md)         |
| `/missions`, `/missions/new`, `/missions/<id>`                                                                              | `(app)/missions/page.tsx`, `(app)/missions/new/page.tsx`, `(app)/missions/[id]/page.tsx`                      | [missions](missions.md)               |
| `POST /api/missions`, `/api/missions/preview`, `/api/missions/<id>/rotate`, `/revoke`, `/gate`, `/members/**`, `/tokens/**` | `api/missions/**/route.ts`                                                                                    | [missions](missions.md)               |
| `GET /agent-bootstrap.md`                                                                                                   | `agent-bootstrap.md/route.ts`                                                                                 | [missions](missions.md)               |
| `/missions/<id>/session`                                                                                                    | `(app)/missions/[id]/session/page.tsx`                                                                        | [audit](audit.md)                     |
| `/audit`                                                                                                                    | `(app)/audit/page.tsx`                                                                                        | [audit](audit.md)                     |
| `/providers`, `/providers/<id>`                                                                                             | `(app)/providers/page.tsx`, `(app)/providers/[id]/page.tsx`                                                   | [audit](audit.md)                     |
| `/requests`, `/requests/<id>`                                                                                               | `(app)/requests/**/page.tsx`                                                                                  | [requests](requests.md)               |
| `GET /r/<id>`                                                                                                               | `r/[id]/route.ts`                                                                                             | [requests](requests.md)               |
| `GET /api/requests`, `POST /api/requests/<id>/decide`                                                                       | `api/requests/**/route.ts`                                                                                    | [requests](requests.md)               |
| `GET, POST, DELETE /mcp`, `GET /mcp/catalog`                                                                                | `mcp/route.ts`, `mcp/catalog/route.ts`                                                                        | [execution-door](execution-door.md)   |
| `GET /.well-known/oauth-protected-resource`                                                                                 | `.well-known/oauth-protected-resource/route.ts`                                                               | [execution-door](execution-door.md)   |
| `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource/mcp/manage`                       | `.well-known/oauth-authorization-server/route.ts`, `.well-known/oauth-protected-resource/mcp/manage/route.ts` | [management-door](management-door.md) |
| `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/authorize/decision`, `POST /oauth/token`, `POST /oauth/revoke` | `oauth/**/route.ts`                                                                                           | [management-door](management-door.md) |
| `GET, POST, DELETE /mcp/manage`                                                                                             | `mcp/manage/route.ts`                                                                                         | [management-door](management-door.md) |
| `/delegations`, `POST /delegations/<id>/revoke`                                                                             | `(app)/delegations/**`                                                                                        | [management-door](management-door.md) |
| `/admin/oauth-clients`, `POST /admin/oauth-clients/<id>`                                                                    | `admin/(guarded)/oauth-clients/**`                                                                            | [management-door](management-door.md) |
| `GET /healthz`                                                                                                              | `healthz/route.ts`                                                                                            | [configuration](configuration.md)     |

There is no landing page: `/` redirects a visitor with a session to `/missions`
and anyone else to `/login`.

The table names the method a caller uses. The three `.well-known` routes also
export `HEAD` and `OPTIONS`, and `POST /oauth/register`, `/oauth/token` and
`/oauth/revoke` also export `OPTIONS`, on the same handler
([management-door](management-door.md)). A segment that holds only a
`route.ts` has no page: `/connections/<id>/shares`, `/connections/connect/…`,
`/delegations/<id>/revoke` and the `admin/(guarded)` mutations answer `POST`
only.

## Layouts

- **Root — `app/layout.tsx`.** `<html lang="en" data-theme="light">` with the
  Geist Sans and Geist Mono font variables (`geist` package), the page
  `metadata` (title `Vaubaan Gateway` and a one-sentence description of the
  instance), and `globals.css`. It reads no session.
- **`globals.css`** imports `src/styles/tokens.css` (the design tokens: colours
  per theme, spacing, radii, type scale; the root layout pins the light theme),
  sets the root font size to 125 %, the base element styles (headings, links,
  focus ring, `code`) and one global class, `.vbn-container` (the page column),
  which `Container` uses.
- **Icons.** `app/icon.svg` and `app/apple-icon.png` are picked up by the Next
  file convention.
- **`(public)/layout.tsx`** — the pages reachable without a session (`/login`):
  the page inside a `Container`.
- **`(app)/layout.tsx`** — the human surface: `currentPrincipal()`; no
  principal → `redirect('/login')`; otherwise `<AppShell principal>`.
- **`admin/(guarded)/layout.tsx`** — the Administration bar (the brand link
  "Vaubaan · Administration" to `/admin`, then Identity provider, Provider apps,
  Users, Groups, Connections, Telemetry, OAuth clients; the same account block as the
  shell on the right) and the "Not an operator" explanation; rules in
  [authentication](authentication.md). The bar has no link back to the
  application bar.
  `/admin/bootstrap` is outside it.

A layout is navigation, never the authorization boundary: the App Router can
render a page segment without its layout. Every page and every route
authenticates itself (next section).

## Session helpers — `lib/auth/session.ts`

Server components learn who is behind the request through one of these. They
add `headers()` and Next's navigation to the authenticator of `src/server/auth`;
authority is recomputed on every request.

| Helper               | For                                                               | No session                    | Bootstrap operator                        | Signed-in user                              |
| -------------------- | ----------------------------------------------------------------- | ----------------------------- | ----------------------------------------- | ------------------------------------------- |
| `currentPrincipal()` | pages open to anyone (`/`, `/login`, `/admin/bootstrap`), layouts | `principal: null`             | the principal                             | the principal                               |
| `requirePrincipal()` | an `(app)` page open to every session (`/audit`, `/providers/**`) | `redirect('/login')`          | the principal                             | the principal                               |
| `currentUser()`      | an `(app)` page that needs an identified user                     | `redirect('/login')`          | `null` → the page renders `<NeedsUser />` | `{ root, principal, user }`                 |
| `requireOperator()`  | every page under `admin/(guarded)`                                | redirect to the admin sign-in | the principal while the token is active   | the principal if operator, else "not found" |

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
  bar or the "Not an operator" explanation without redirecting.
- A `route.ts` under `(app)` calls no helper: it delegates to a handler of its
  module — `src/server/connections/handlers.ts` (connect, callback, discover,
  revoke, resource edit, transfer), `src/server/shares/handlers.ts` (share,
  revoke a share) or `src/server/oauth-as/handlers.ts` (`revokeDelegation`) —
  which checks the origin, then the session, then that the principal is a user
  (the provider callback, a top-level GET, checks the session and the
  single-use `state`).

## The shell — `components/shell/`

`AppShell({ principal, children })` (server component) renders one bar, then
the page in a `Container`, then the build footer. The bar is **one line**: its
entries never wrap (`shell.module.css`, `.nav`), and a Playwright assertion
holds it at 1280 px for an operator.

- the brand link (to `/connections`) and one link per entry of `APP_NAV`:
  **Connections**, **Shares**, **Missions**, **Requests**, **Audit**,
  **Delegations**, **Providers**. A label is one short word — the page behind
  "Shares" is still titled "Shares received" — so that one more entry fits.
  Every principal sees these links;
- **Admin** (`/admin`), only when `isOperatorPrincipal(principal)`
  (`components/auth/principal.ts`): the bootstrap operator or a user with
  `isOperator`. `PrincipalCard` (the account card of `/login` for a visitor
  who already has a session) and the Audit page's sentence read the same
  function;
- the links are rendered by `NavLinks` (client, `usePathname`): the entry the
  path is under (`isCurrentSection` in `shell/nav.ts`: equal, or below it)
  carries `aria-current="page"`, a heavier word and a rule under it;
- on the right, `UserMenu` (client): one button with the user's email (or
  `bootstrap token`), cut with an ellipsis past 260 px and whole in its
  `title` and `aria-label` ("Account: `<email>`"). It opens a small panel —
  the only overlay surface with a shadow — holding `OperatorBadge`
  (`Operator` / `User` / "Bootstrap operator") and `SignOutButton`, both from
  `components/auth/PrincipalCard.tsx`. Escape or a click outside closes it.
  `data-testid="user-menu"`.

The Administration layout keeps its own bar (`components/auth/auth.module.css`,
`.adminBar`): it was not reshaped.

`BuildFooter` (server component, `shell.module.css`) is one line at the
bottom of every page: `Vaubaan Gateway <version> · <commit>`, the build
stamps of `server/config/build-info.ts` — the values `/healthz` answers and
telemetry reports as `gateway_version`; `dev` for an unstamped build. The
three layouts render it: `AppShell`, the Administration layout and the
public layout (`/login`). `/admin/bootstrap` and the OAuth consent screen,
which have no layout of their own, do not. `data-testid`: `build-footer`,
`gateway-version`, `gateway-commit`. The version has one source, the root
`package.json` ([coding workflow, "One version"](../workflow/coding-workflow.md#one-version)).

`AppNavEntry` is `{ href, label, Count? }`. `Count` is an optional server
component rendered after the label with the principal; `AppShell` renders it
and hands the result to `NavLinks` as a node. The only one is
`OpenRequestCount` on "Requests": a warning badge with the number of open
requests awaiting the signed-in user as creator, nothing at zero and nothing
for the bootstrap operator ([requests](requests.md)).

Seeing a link is not the authorisation. Each page decides for its principal
with a session helper: the Connections, Shares received, Missions, Requests and Delegations pages render
`NeedsUser` for the bootstrap operator (`currentUser()`), `/audit` is open to
both (`requirePrincipal()`) and widens what it shows for an operator.

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

## UI primitives — `components/ui/`

Imported from `@/components/ui` (`index.ts`). Styles are CSS modules next to
each file and use the tokens only.

| Export                                        | What it is                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                      | `<button>` with `variant` (`primary`, `secondary`, `ghost`, `danger`; default `secondary`), `size` (`sm`, `md`; default `md`) and `loading` (disables the button), ref forwarded                                                                                              |
| `Input`, `Textarea`, `Select`                 | styled form controls, refs forwarded                                                                                                                                                                                                                                          |
| `Field`                                       | a labelled field with `label`, `htmlFor`, `hint` and `error` (the error replaces the hint)                                                                                                                                                                                    |
| `Card`, `CardHeader`, `CardTitle`, `CardBody` | the bordered panel and its parts                                                                                                                                                                                                                                              |
| `Badge`                                       | inline status, `tone`: `neutral` (default), `info`, `success`, `warning`, `danger` (`BadgeTone`); `mono` for the monospace face                                                                                                                                               |
| `Banner`                                      | block message with an optional `title`, same tones (default `info`)                                                                                                                                                                                                           |
| `Table`, `Thead`, `Tbody`, `Tr`, `Th`, `Td`   | styled table elements                                                                                                                                                                                                                                                         |
| `Container`, `Stack`                          | page column (`.vbn-container`), vertical flex with a `gap`                                                                                                                                                                                                                    |
| `Code`                                        | inline `<code>`                                                                                                                                                                                                                                                               |
| `DangerConfirm`                               | client modal: the user types `phrase` before Confirm enables; Escape or the backdrop cancels (not while `busy`). Used by the mission actions and `RevokeConnection`                                                                                                           |
| `Slug`                                        | the name of an object in the colour of its kind (`kind`, below): an inline tag with the glyph of the kind, a visually hidden word for it, `href` to make it a link, `newTab`, `mono={false}` for a human name                                                                 |
| `Glyph`                                       | the one glyph set, drawn in `Glyph.tsx` (no icon package): one 12 px line drawing per kind, plus `help`, `chevron`, `warning`, `info`, `key`, `flask`, `archive`, `user`; always `aria-hidden`                                                                                |
| `Callout`                                     | a note with an icon and a short title on a neutral surface (`role="note"`); only the icon and the title carry the tone. Used for the fallback, deprecated, token hand-out and experimental notes                                                                              |
| `Help`, `HelpButton`, `useHelp`               | client. Help on demand: `Help({ id, line })` shows one line and a "More" button; the panel is closed by default and its state is remembered per browser (`localStorage`, key `vaubaan:help:<id>`). `useHelp` + `HelpButton` are the same thing for a panel rendered elsewhere |
| `TabList`, `TabPanel`                         | client. Tabs with the ARIA roles and keyboard (arrows, Home, End; a tab is selected when it takes focus); the state belongs to the caller                                                                                                                                     |
| `KindLegend`                                  | "what the colours mean": every kind as its slug, with one sentence                                                                                                                                                                                                            |
| `ITEM_KINDS`, `ITEM_KIND_WORDS`, `ItemKind`   | the list of kinds, and the label and meaning of each (`kinds.ts`)                                                                                                                                                                                                             |

**Labels are bound to their controls.** A `Field` that holds one control
takes `htmlFor`, the `id` of that control, and renders a real
`<label for>`: clicking the label focuses the control and assistive technology
announces it. A `Field` that holds several controls (the claim mapping of the
identity provider) takes no `htmlFor`: its wrapper is a `role="group"` named by
the label, and each control carries its own `aria-label`. Ids must be unique on
the page: `CredentialFieldInputs` (`components/connections/parts.tsx`) takes an
`idPrefix` and derives one id per field with `credentialFieldId(idPrefix,
name)`; Admin → Provider apps passes `provider-app-<provider id>` because it
renders one list per provider. Controls outside a `Field` are either wrapped in
their `<label>` (Audit filters, the request decision form, checkboxes) or carry
an `aria-label` (the mission form, the inline resource cells).

### Type colours: what kind of thing a name is

Every name the interface prints for an object — as a row, a column, or a mere
reference — carries the colour of its **kind**, through `Slug` or through
`data-kind` on its container. The colour says what kind of thing it is and
nothing else: severity, class of risk, gate, status and callouts keep the four
status accents and their own marks (a filled badge, an outlined word, the
vector strip). A kind is never said by the colour alone: the slug has its
glyph, its `title` and a visually hidden word (`Risk: `, `Tool: `…).

| Kind         | Hue (`tokens.css`) | Glyph      | Where it appears                                                                                                                           |
| ------------ | ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `risk`       | `violet`           | diamond    | every risk id (`RiskIdLink`): mission page, Custom editor, Share dialog, Requests, session, Audit, Shares received; the rail of a risk row |
| `preset`     | `teal`             | three bars | the columns of the preset matrix, the preset tags of a risk row, the chosen preset of mission creation                                     |
| `tool`       | `pink`             | prompt     | tool names: the tools table, a risk's declared tools, Audit, session, Requests                                                             |
| `plane`      | `lime`             | branch     | planes and entities of a data model: the plane control, the outline, the index cards, the tools table                                      |
| `resource`   | `cyan`             | box        | resource refs: mission page, mission creation, connection page, Audit                                                                      |
| `connection` | `indigo`           | two rings  | connection names: mission page, Audit                                                                                                      |
| `mission`    | `orange`           | flag       | mission names: Audit, Requests                                                                                                             |
| `token`      | `gold`             | key        | the masked mission token: mission page, missions list                                                                                      |

Tokens, in `styles/tokens.css`: eight hue families of four steps (50, 200, 600, 900) beside the status accents, and per kind three semantic tokens mapped per
theme — `--type-<kind>-rail` (step 600: a rail, a band, the glyph),
`--type-<kind>-bg` and `--type-<kind>-fg` (the tag: 50 under 900 in light, 900
under 200 in dark). The same file ends with one rule per kind,
`[data-kind='<kind>'] { --kind-rail; --kind-bg; --kind-fg }`: a component
reads the three `--kind-*` variables and never a family step. Adding a kind is
one entry in `kinds.ts` (the compiler then asks for its words and its glyph),
its tokens in both themes and its `[data-kind]` rule;
`tests/unit/app/item-kinds.test.ts` fails until the three exist, and if two
kinds share a hue or one borrows a status hue.

`tokens.css` also gained `--text-2xs` (the axis captions of the vector strip
and the captions of the budget columns), and `globals.css` a
`prefers-reduced-motion` rule (transitions and animations take no time), the
`.vbn-sr-only` utility and the focus ring on `summary` and `[tabindex]`.

### Display helpers

Shared by the pages that used to carry a copy each:

- `components/risk/RiskExplain.tsx`: how a risk is explained everywhere —
  `RiskExplain` (a compact row: label and class, id and one line of reason
  that unfolds, the vector strip), `VectorStrip`, `VectorLegend`,
  `RiskIdLink`, `RiskClassTag`, `RiskReason`, `RiskMarkers` (handbook
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
(`/admin`, `/admin/bootstrap`, `/admin/oauth-clients`) use it; the Connections
list, the connection page and Shares received still print the UTC day
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

## The provider reference — `/providers`

Documentation of the instance inside the instance (spec §4.2 "Providers"): what
each shipped plugin connects to and what a mission can accept on it. Both pages
call `requirePrincipal()`: any session reads them, the bootstrap operator
included; they show no connection, no mission and no credential. The
structural test of the surface (`tests/unit/app/app-guard.test.ts`) lists them
with `/audit` among the pages open to any session.

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
line; the rest, with the colour legend, is behind "More".

**`/providers/<id>`** is a compact header rendered by the server (`[id]/page.tsx`)
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
  **Risks**, **Data model**, **Tools**, each with its count. Selecting a tab
  writes its fragment (`#presets`, `#risks`, `#data-model`, `#tools`).
- **Plane control** — only when the model has several planes (today
  Supabase): native radios drawn as pills, "All", one per plane, and `other`
  when something is filed there. It slices every tab at once: the rows of the
  matrix, the risk list, the outline, the tools, and the counts on the tabs.
  `data-testid="plane-control"`.
- **Help** — "How to read this page" (`useHelp('provider-reference')`,
  `#legend` opens it): presets and risks in one paragraph, how to read a risk
  with the legend of the six axes and the two markers, what the colours mean
  (`KindLegend`), how planes are read. Closed by default.

The four sections, one file each beside the page:

1. **Presets** (`preset-matrix.tsx`, `#presets`) — one table: a column per
   preset (`<th id="preset-<id>">`, the preset colour as a band, its label, its
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
   a call comes from (`EnvironmentReference.source`: `call` when the plugin
   declares `envOf`, `resource-label` when the catalog has env-scoped entries,
   `none` otherwise), then each plane as an outline with connectors: the
   entity, its cardinalities as small annotations, its description; the
   carrier of the environment has a badge and a band.
4. **Tools** (`tool-table.tsx`, `#tools`) — a dense table: the name as a
   `tool` slug, the description, required and optional arguments, the plane
   when the model has several, and the risks. The "Risks" column reads "by
   arguments": a plugin classifies a call from its arguments and declares no
   table of the risks of each tool; the page says so in one line and the rest
   (`TOOL_RISKS_NOTE`: `tools/list` is filtered per provider, a listed tool can
   still be refused, the catalog endpoint of the execution door is the precise
   source) is behind "More". The one exception is a tool the plugin declares
   in `tokenHandouts` ([plugin-sdk](plugin-sdk.md)): its row lists the
   declared risks under a **"hands a token to the agent"** badge, a callout
   above the table states `TOKEN_HANDOUT_NOTE` (spec §2.4), and each of those
   risks carries the badge and, unfolded, the callout and the tool. Today that
   is `github__mint_install_token` and the two `github.mint-install-token-*`
   risks.

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

1. **Place it** under `(app)/` to get the session redirect and the bar, under
   `admin/(guarded)/` for an operator page, under `(public)/` if it must work
   without a session. Add one entry to `APP_NAV` if it belongs in the bar.
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
5. **Build with the primitives** above; page-specific styles go in a CSS module
   next to the page. Give every single-control `Field` an `htmlFor` and its
   control the matching `id`.
6. **Document it** in the handbook of its feature and add its route to the map
   above.

## Tests

Six unit files under `apps/gateway/tests/unit/app/` run without a browser
(`npx vitest run apps/gateway/tests/unit/app`):

- `app-guard.test.ts` discovers every `page.tsx` and `route.ts` under `(app)`.
  Each page must call a session helper before it reads the root, redirect a
  visitor with no session (and a bootstrap session whose token was revoked) to
  `/login`, render only `NeedsUser` for the bootstrap operator (`/audit`
  excepted), and render or answer "not found" for a signed-in user. Each route
  must delegate to a handler listed as authenticating, refuse a caller with no
  session and the bootstrap operator, and let a signed-in user through.
- `admin-guard.test.ts` does the same for `admin/(guarded)` with
  `requireOperator()` ([authentication](authentication.md)).
- `field.test.tsx` renders `Field` and `CredentialFieldInputs` with
  `renderToStaticMarkup`: label bound by `for`/`id`, group role without
  `htmlFor`, unique ids when two lists share a page.

- `item-kinds.test.ts` reads `tokens.css`: every kind of `kinds.ts` has its
  three tokens in both themes and its `[data-kind]` rule, no kind borrows a
  status hue, no two kinds share one; and the rule that marks the current
  section of the bar (`isCurrentSection`).
- `risk-explain.test.tsx` renders `Slug`, `RiskIdLink`, `KindLegend`,
  `VectorStrip`, `RiskExplain`, `Help` and `Callout` to static markup: the
  kind as attribute, glyph and hidden word; six cells with the axis named in
  full; help closed.

`server/providers/planes.test.ts` covers the plane rules on a two-plane model
and on the shipped Supabase and GitHub plugins.

Three helpers have a unit file beside them:
`components/auth/principal.test.ts`, `app/(app)/missions/message-of.test.ts`
and `app/(app)/missions/new/form-state.test.ts` (the state of the mission
form, [missions](missions.md)).

`guard-harness.ts` holds what the two guard files share (file discovery, calling
a page as a function, naming a redirect or a "not found").

`build-footer.test.tsx`, the fourth, renders the footer (given stamps, the
stamps of the build, `dev`), and
`tests/unit/structural/version-single-source.test.ts` checks that the build
stamps the version of the root `package.json`.

The other primitives and the rest of the shell have no unit test of their own. They are
exercised by the Playwright suite `apps/gateway/tests/e2e/v5/` (`npm run test:e2e:v5`,
seven specs): navigation through the bar (`navigation` named "Main", on one
line at 1280 px, the current entry marked, the account menu), the tabs, the
plane control, the fragments and the help of the provider reference, the open
request count (`data-testid="open-request-count"`), forms, tables and dialogs of
the Missions, Requests, Audit, Connections (shares), Delegations and Providers pages. The
suite runs the standalone server of the build, the one the image starts
([e2e tests](../tests/e2e-tests.md)). What a page decides is tested without
Next, in the unit and integration suites of its `src/server/**` module (`npm
test`); see each feature handbook.

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2.
- Handbooks: [authentication](authentication.md),
  [connections](connections.md), [authority](authority.md),
  [missions](missions.md), [requests](requests.md), [audit](audit.md),
  [execution-door](execution-door.md), [management-door](management-door.md),
  [telemetry](telemetry.md), [configuration](configuration.md).
- v4 text: [legacy/web-app.md](legacy/web-app.md).
