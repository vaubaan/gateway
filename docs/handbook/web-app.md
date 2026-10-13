---
title: Web app — route map, layouts, shell, UI primitives
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/app/layout.tsx
  - apps/gateway/src/app/globals.css
  - apps/gateway/src/app/icon.svg
  - apps/gateway/src/app/apple-icon.png
  - apps/gateway/src/styles/tokens.css
  - apps/gateway/src/components/ui/
  - apps/gateway/src/components/shell/
  - apps/gateway/src/components/LocalDate.tsx
  - apps/gateway/src/components/auth/NeedsUser.tsx
  - apps/gateway/src/lib/auth/session.ts
  - apps/gateway/src/lib/connections/session.ts
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
  creation form and its per-risk table, the mission actions, the bootstrap kit
  view, `RevokeConnection`, `DangerConfirm` and `LocalDate`. The only `fetch`
  calls from the browser are the mission form (`POST /api/missions`,
  `POST /api/missions/preview`) and the mission actions
  (`POST /api/missions/<id>/rotate|revoke`).
- **Everything that decides lives under `src/server/`**, host-agnostic (it
  never imports `next`). A `route.ts` is a one-line adapter:
  `(await getRoot()).<module>.handlers.<name>(request, …)`.

## Route map

| Route                                                                                  | File under `apps/gateway/src/app/`                                   | Handbook                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| `/`                                                                                    | `page.tsx`                                                           | [authentication](authentication.md) |
| `/login`                                                                               | `(public)/login/page.tsx`, `(public)/layout.tsx`                     | [authentication](authentication.md) |
| `GET /auth/login`, `GET /auth/callback`                                                | `auth/login/route.ts`, `auth/callback/route.ts`                      | [authentication](authentication.md) |
| `POST /logout`                                                                         | `logout/route.ts`                                                    | [authentication](authentication.md) |
| `/admin/bootstrap`, `POST /api/auth/bootstrap`                                         | `admin/bootstrap/page.tsx`, `api/auth/bootstrap/route.ts`            | [authentication](authentication.md) |
| `/admin`, `/admin/identity-provider`                                                   | `admin/(guarded)/**`                                                 | [authentication](authentication.md) |
| `POST /api/admin/identity-provider`                                                    | `api/admin/identity-provider/route.ts`                               | [authentication](authentication.md) |
| `/admin/provider-apps`, `POST /admin/provider-apps/<provider>`                         | `admin/(guarded)/provider-apps/**`                                   | [connections](connections.md)       |
| `/admin/telemetry`, `POST /api/admin/telemetry`                                        | `admin/(guarded)/telemetry/page.tsx`, `api/admin/telemetry/route.ts` | [telemetry](telemetry.md)           |
| `/connections`, `/connections/new`, `/connections/new/<provider>`, `/connections/<id>` | `(app)/connections/**/page.tsx`                                      | [connections](connections.md)       |
| `POST /connections/connect/<provider>`, `GET /connections/callback/<provider>`         | `(app)/connections/connect/`, `(app)/connections/callback/`          | [connections](connections.md)       |
| `POST /connections/<id>/discover`, `/revoke`, `/resources/<resourceId>`                | `(app)/connections/[id]/**/route.ts`                                 | [connections](connections.md)       |
| `/missions`, `/missions/new`, `/missions/<id>`                                         | `(app)/missions/**/page.tsx`                                         | [missions](missions.md)             |
| `POST /api/missions`, `/api/missions/preview`, `/api/missions/<id>/rotate`, `/revoke`  | `api/missions/**/route.ts`                                           | [missions](missions.md)             |
| `GET /agent-bootstrap.md`                                                              | `agent-bootstrap.md/route.ts`                                        | [missions](missions.md)             |
| `/missions/<id>/session`                                                               | `(app)/missions/[id]/session/page.tsx`                               | [audit](audit.md)                   |
| `/audit`                                                                               | `(app)/audit/page.tsx`                                               | [audit](audit.md)                   |
| `/requests`, `/requests/<id>`                                                          | `(app)/requests/**/page.tsx`                                         | [requests](requests.md)             |
| `GET /r/<id>`                                                                          | `r/[id]/route.ts`                                                    | [requests](requests.md)             |
| `GET /api/requests`, `POST /api/requests/<id>/decide`                                  | `api/requests/**/route.ts`                                           | [requests](requests.md)             |
| `GET, POST, DELETE /mcp`, `GET /mcp/catalog`                                           | `mcp/route.ts`, `mcp/catalog/route.ts`                               | [execution-door](execution-door.md) |
| `GET /.well-known/oauth-protected-resource`                                            | `.well-known/oauth-protected-resource/route.ts`                      | [execution-door](execution-door.md) |
| `GET /healthz`                                                                         | `healthz/route.ts`                                                   | [configuration](configuration.md)   |

There is no landing page: `/` redirects a visitor with a session to `/missions`
and anyone else to `/login`.

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
- **`admin/(guarded)/layout.tsx`** — the Administration bar (Identity provider,
  Provider apps, Telemetry) and the "Not an operator" explanation; rules in
  [authentication](authentication.md). `/admin/bootstrap` is outside it.

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
| `requirePrincipal()` | an `(app)` page open to every session (`/audit`)                  | `redirect('/login')`          | the principal                             | the principal                               |
| `currentUser()`      | an `(app)` page that needs an identified user                     | `redirect('/login')`          | `null` → the page renders `<NeedsUser />` | `{ root, principal, user }`                 |
| `requireOperator()`  | every page under `admin/(guarded)`                                | redirect to the admin sign-in | the principal while the token is active   | the principal if operator, else "not found" |

- `currentUser()` is the single answer to "the bootstrap operator opened a page
  that needs a user": Missions, the mission session, Connections and Requests
  all render `NeedsUser` (`components/auth/NeedsUser.tsx`), one warning banner
  that says the bootstrap token owns no mission, connection or request and
  links to Administration → Identity provider. No page redirects the bootstrap
  operator elsewhere.
- `currentActor()` (`lib/connections/session.ts`) is `currentUser()` plus the
  `Actor` (`{ user, groups }`) the connection service expects; the Connections
  pages use it. The same file holds `firstParam`, `PageSearchParams` and
  `takeNotice`.
- A `route.ts` under `(app)` calls no helper: it delegates to a handler of
  `src/server/connections/handlers.ts`, which checks the origin, then the
  session, then that the principal is a user (the provider callback, a
  top-level GET, checks the session and the single-use `state`).

## The shell — `components/shell/`

`AppShell({ principal, children })` (server component) renders one bar, then
the page in a `Container`:

- the brand link (to `/connections`) and one link per entry of `APP_NAV`:
  **Connections**, **Shares received**, **Missions**, **Requests**, **Audit**.
  Every principal sees these links;
- **Administration** (`/admin`), only when the principal is the bootstrap
  operator or a user with `isOperator`;
- on the right: the user's email (or `bootstrap token`), `OperatorBadge`
  (`Operator` / `User` / "Bootstrap operator") and `SignOutButton`, both from
  `components/auth/PrincipalCard.tsx`.

`AppNavEntry` is `{ href, label, Count? }`. `Count` is an optional server
component rendered after the label with the principal. The only one is
`OpenRequestCount` on "Requests": a warning badge with the number of open
requests awaiting the signed-in user as creator, nothing at zero and nothing
for the bootstrap operator ([requests](requests.md)).

Seeing a link is not the authorisation. Each page decides for its principal
with a session helper: the Connections, Missions and Requests pages render
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

## UI primitives — `components/ui/`

Imported from `@/components/ui` (`index.ts`). Styles are CSS modules next to
each file and use the tokens only.

| Export                                        | What it is                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Button`                                      | `<button>` with `variant` (`primary`, `secondary`, `ghost`, `danger`) and `size` (`sm`, `md`) |
| `Input`, `Textarea`, `Select`                 | styled form controls, refs forwarded                                                          |
| `Field`                                       | a labelled field with `label`, `htmlFor`, `hint` and `error` (the error replaces the hint)    |
| `Card`, `CardHeader`, `CardTitle`, `CardBody` | the bordered panel and its parts                                                              |
| `Badge`                                       | inline status, `tone`: `neutral`, `info`, `success`, `warning`, `danger` (`BadgeTone`)        |
| `Banner`                                      | block message with an optional `title`, same tones (default `info`)                           |
| `Table`, `Thead`, `Tbody`, `Tr`, `Th`, `Td`   | styled table elements                                                                         |
| `Container`, `Stack`                          | page column (`.vbn-container`), vertical flex with a `gap`                                    |
| `Code`                                        | inline `<code>`                                                                               |
| `DangerConfirm`                               | client modal: the user types `phrase` before Confirm enables; Escape or the backdrop cancels  |

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

`components/LocalDate.tsx` (client) renders a timestamp: the ISO form on the
server, the browser's locale after hydration, without a hydration mismatch.
`dateOnly` drops the time. The Missions, session, Requests, Audit and
Administration pages use it; the Connections pages still print the UTC day
(`iso.slice(0, 10)`).

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

Three unit files under `apps/gateway/tests/unit/app/` run without a browser
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

`guard-harness.ts` holds what the two guard files share (file discovery, calling
a page as a function, naming a redirect or a "not found").

The other primitives and the shell have no unit test of their own. They are
exercised by the Playwright suite `apps/gateway/tests/e2e/v5/` (`npm run test:e2e:v5`,
three specs): navigation through the bar (`navigation` named "Main"), the open
request count (`data-testid="open-request-count"`), forms, tables and dialogs of
the Missions, Requests and Audit pages. What a page decides is tested without
Next, in the unit and integration suites of its `src/server/**` module (`npm
test`); see each feature handbook.

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2.
- Handbooks: [authentication](authentication.md),
  [connections](connections.md), [missions](missions.md),
  [requests](requests.md), [audit](audit.md),
  [execution-door](execution-door.md), [configuration](configuration.md).
- v4 text: [legacy/web-app.md](legacy/web-app.md).
