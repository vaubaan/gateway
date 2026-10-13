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
  the composition root (`getRoot()`, reached with `currentPrincipal()`), are all
  `dynamic = 'force-dynamic'`, and render HTML. No page loads its data from the
  browser.
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

| Route                                                                                  | File under `apps/gateway/src/app/`                          | Handbook                            |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------- |
| `/`                                                                                    | `page.tsx`                                                  | [authentication](authentication.md) |
| `/login`                                                                               | `(public)/login/page.tsx`, `(public)/layout.tsx`            | [authentication](authentication.md) |
| `GET /auth/login`, `GET /auth/callback`                                                | `auth/login/route.ts`, `auth/callback/route.ts`             | [authentication](authentication.md) |
| `POST /logout`                                                                         | `logout/route.ts`                                           | [authentication](authentication.md) |
| `/admin/bootstrap`, `POST /api/auth/bootstrap`                                         | `admin/bootstrap/page.tsx`, `api/auth/bootstrap/route.ts`   | [authentication](authentication.md) |
| `/admin`, `/admin/identity-provider`                                                   | `admin/(guarded)/**`                                        | [authentication](authentication.md) |
| `POST /api/admin/identity-provider`                                                    | `api/admin/identity-provider/route.ts`                      | [authentication](authentication.md) |
| `/admin/provider-apps`, `POST /admin/provider-apps/<provider>`                         | `admin/(guarded)/provider-apps/**`                          | [connections](connections.md)       |
| `/connections`, `/connections/new`, `/connections/new/<provider>`, `/connections/<id>` | `(app)/connections/**/page.tsx`                             | [connections](connections.md)       |
| `POST /connections/connect/<provider>`, `GET /connections/callback/<provider>`         | `(app)/connections/connect/`, `(app)/connections/callback/` | [connections](connections.md)       |
| `POST /connections/<id>/discover`, `/revoke`, `/resources/<resourceId>`                | `(app)/connections/[id]/**/route.ts`                        | [connections](connections.md)       |
| `/missions`, `/missions/new`, `/missions/<id>`                                         | `(app)/missions/**/page.tsx`                                | [missions](missions.md)             |
| `POST /api/missions`, `/api/missions/preview`, `/api/missions/<id>/rotate`, `/revoke`  | `api/missions/**/route.ts`                                  | [missions](missions.md)             |
| `GET /agent-bootstrap.md`                                                              | `agent-bootstrap.md/route.ts`                               | [missions](missions.md)             |
| `/missions/<id>/session`                                                               | `(app)/missions/[id]/session/page.tsx`                      | [audit](audit.md)                   |
| `/audit`                                                                               | `(app)/audit/page.tsx`                                      | [audit](audit.md)                   |
| `/requests`, `/requests/<id>`                                                          | `(app)/requests/**/page.tsx`                                | [requests](requests.md)             |
| `GET /r/<id>`                                                                          | `r/[id]/route.ts`                                           | [requests](requests.md)             |
| `GET /api/requests`, `POST /api/requests/<id>/decide`                                  | `api/requests/**/route.ts`                                  | [requests](requests.md)             |
| `GET, POST, DELETE /mcp`, `GET /mcp/catalog`                                           | `mcp/route.ts`, `mcp/catalog/route.ts`                      | [execution-door](execution-door.md) |
| `GET /.well-known/oauth-protected-resource`                                            | `.well-known/oauth-protected-resource/route.ts`             | [execution-door](execution-door.md) |
| `GET /healthz`                                                                         | `healthz/route.ts`                                          | [configuration](configuration.md)   |

There is no landing page: `/` redirects a visitor with a session to `/missions`
and anyone else to `/login`.

## Layouts

- **Root — `app/layout.tsx`.** `<html lang="en" data-theme="light">` with the
  Geist Sans and Geist Mono font variables (`geist` package), the page
  `metadata` (title and description), and `globals.css`. It reads no session.
- **`globals.css`** imports `src/styles/tokens.css` (the design tokens: colours
  per theme, spacing, radii, type scale; the root layout pins the light theme),
  sets the root font size to 125 %, the base element styles (headings, links,
  focus ring, `code`) and a few global classes, of which `.vbn-container` (the
  page column) is the one `Container` uses.
- **Icons.** `app/icon.svg` and `app/apple-icon.png` are picked up by the Next
  file convention.
- **`(public)/layout.tsx`** — the pages reachable without a session (`/login`):
  the page inside a `Container`.
- **`(app)/layout.tsx`** — the human surface: `currentPrincipal()`; no
  principal → `redirect('/login')`; otherwise `<AppShell principal>`.
- **`admin/(guarded)/layout.tsx`** — the Administration guard and its own bar
  (Identity provider, Provider apps); rules in
  [authentication](authentication.md). `/admin/bootstrap` is outside the guard.

## The shell — `components/shell/`

`AppShell({ principal, children })` (server component) renders one bar, then
the page in a `Container`:

- the brand link (to `/connections`) and one link per entry of `APP_NAV`:
  **Connections**, **Missions**, **Requests**, **Audit**. Every principal sees
  these four links;
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

Seeing a link is not the authorisation. Each page decides for its principal:
the Connections pages send the bootstrap operator to `/admin`
(`requireUser()`), the Missions pages render `NeedsUser`, `/audit` is open to
both and widens what it shows for an operator.

## UI primitives — `components/ui/`

Imported from `@/components/ui` (`index.ts`). Styles are CSS modules next to
each file and use the tokens only.

| Export                                                      | What it is                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Button`                                                    | `<button>` with `variant` (`primary`, `secondary`, `ghost`, `danger`) and `size` (`sm`, `md`)   |
| `Input`, `Textarea`, `Select`                               | styled form controls, refs forwarded                                                            |
| `Label`, `Field`                                            | a label; a field group with `label`, `hint` and `error` (the error replaces the hint)           |
| `Card`, `CardHeader`, `CardTitle`, `CardBody`, `CardFooter` | the bordered panel and its parts                                                                |
| `Badge`                                                     | inline status, `tone`: `neutral`, `info`, `success`, `warning`, `danger` (`BadgeTone`)          |
| `Banner`                                                    | block message with an optional `title`, same tones (default `info`)                             |
| `Table`, `Thead`, `Tbody`, `Tr`, `Th`, `Td`                 | styled table elements                                                                           |
| `Container`, `Stack`, `Row`, `Spacer`                       | page column (`.vbn-container`), vertical and horizontal flex with a `gap`, fixed vertical space |
| `Code`, `KeyHint`                                           | inline `<code>` and `<kbd>`                                                                     |
| `DangerConfirm`                                             | client modal: the user types `phrase` before Confirm enables; Escape or the backdrop cancels    |

`components/LocalDate.tsx` (client) renders a timestamp: the ISO form on the
server, the browser's locale after hydration, without a hydration mismatch.
`dateOnly` drops the time. The Missions, session, Requests and Audit pages use
it.

## Adding a page

1. **Place it** under `(app)/` to get the session redirect and the bar, under
   `admin/(guarded)/` for an operator page, under `(public)/` if it must work
   without a session. Add one entry to `APP_NAV` if it belongs in the bar.
2. **Read the session through the authenticator**: `currentPrincipal()`
   (`lib/auth/session.ts`) returns `{ root, principal }` from
   `root.auth.authenticator.authenticate(headers)`; `adminDecision()` adds
   `authorizeAdmin`. Authority is recomputed on every request, never read from
   the session. Decide what the bootstrap operator sees: they have a session
   but are not a user.
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
   next to the page.
6. **Document it** in the handbook of its feature and add its route to the map
   above.

## Tests

The primitives and the shell have no unit test of their own. They are exercised
by the Playwright suite `apps/gateway/tests/e2e/v5/` (`npm run test:e2e:v5`,
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
