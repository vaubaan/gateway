---
title: Web app
tracks:
  - apps/gateway/src/app/layout.tsx
  - apps/gateway/src/app/(app)/layout.tsx
  - apps/gateway/src/app/admin/(guarded)/layout.tsx
  - apps/gateway/src/styles/tokens.css
  - apps/gateway/src/components/ui/
  - apps/gateway/src/components/shell/
  - apps/gateway/src/lib/vocabulary.ts
  - apps/gateway/src/lib/dates.ts
  - apps/gateway/src/lib/theme.ts
  - apps/gateway/src/lib/auth/session.ts
  - apps/gateway/src/app/(app)/design/
  - apps/gateway/src/server/now/
  - apps/gateway/src/server/http/document.ts
  - apps/gateway/src/server/providers/
  - apps/gateway/next.config.ts
  - apps/gateway/tests/unit/app/
last_reviewed: 2026-10-27
---

# Web app — handbook

The frame of the human surface: layouts, session helpers, shell, words,
tokens, design system, home and reference. Each page's behaviour is in its
feature's handbook. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2,
[style-guide](../spec/style-guide.md); ADR
[interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md).

## Start here

- [`lib/auth/session.ts`](../../apps/gateway/src/lib/auth/session.ts) — `currentPrincipal`, `requirePrincipal`, `currentUser`, `requireOperator`: how a page gets its reader.
- [`components/shell/`](../../apps/gateway/src/components/shell/) — `AppShell`, `AdminShell`, the path bar, the navigation (`nav.ts`, `settings-nav.ts`).
- [`components/ui/`](../../apps/gateway/src/components/ui/) — the design system; each component's rule of use is in its header and on `/design`.
- [`lib/vocabulary.ts`](../../apps/gateway/src/lib/vocabulary.ts) — every word a person reads, keyed by the protocol name it translates.
- [`next.config.ts`](../../apps/gateway/next.config.ts) — `LEGACY_REDIRECTS`, what the standalone output traces and excludes.

## Invariants

- **Everything that decides is under `src/server/`**, host-agnostic (never imports `next`); a `route.ts` is one line over `root.<module>.handlers`. Pages are server components, `force-dynamic`, reading through `getRoot()`; the only browser `fetch` goes to `/api/missions/**`.
- **A layout is navigation, never the authorization boundary**: the App Router can render a segment without its layout, so every page authenticates itself, first statement, before reading the root (`app-guard.test.ts`, `admin-guard.test.ts` discover every page and route). `src/proxy.ts` decides nothing: it sets the security headers and the CSP nonce.
- **A page shows what its service decides**: a control shown or hidden follows a rule written once next to the act and read from the view (`ownerActRefusal`, `gateEditBlockedBy`, `transferTargets`, `reassignTargets`); a page never re-spells it. `tests/integration/authority/rules-read-by-pages.test.ts` holds both sides.
- **Seven navigation entries is the budget**: a feature adds no entry; a page under none goes in `ALSO_UNDER` (`nav.ts`). Ownerless accounts are an admin-only region of Accounts (`/accounts#without-owner`), shown only when one exists; `/admin/connections` redirects there.
- **Under 641 px** the navigation is a bottom bar (Now, Waiting, Missions, Accounts, More with the other three), and a `DataTable` draws each row as a block of labelled lines; row actions are never hover-only.
- **Every date becomes text through `lib/dates.ts`**, locale-independent: no `toLocale*` or `Intl.DateTimeFormat` in a page (`lib/dates.test.ts` reads the sources). The server writes UTC; client components switch to the reader's zone after hydration.
- **The head of an approval** is the plugin's `toolTitles` and the refused call's `resource_ref`, never an argument. A yes is never given from the home: an approval row leads to its request, where the exact call is shown (`now-and-waiting.test.tsx`).
- **Words live in `vocabulary.ts`** only, the trust levels' names and hints (`TRUST_LEVEL_LABELS`, `TRUST_LEVEL_HINTS`) included: a page never prints a protocol name as prose, it prints an id with `Mono`. Routes follow the words (`/accounts`, `/waiting`); `src/server/` keeps protocol names.
- **A page is built from `components/ui/`**: a missing component is added there with its specimen in `/design`, never in the page. Colours exist only in `tokens.css` as plain hex (`design-tokens.test.ts`: AA pairs, both dark blocks identical, no raw colour elsewhere). The one exception is a service's brand colour: it comes from its plugin (`ServiceIcon`), never a map in the interface, and reaches `ServiceMark` as `--mark-color`; a near-black brand turns to `--ink` in the dark theme (`darkThemeMarkColor`, WCAG luminance under 0.1).
- **Every human page carries `BuildFooter`**, including the authorization server's HTML pages; one version source, the root `package.json`.
- **The reference is generated** from the plugin registry (`server/providers/reference.ts`): a registered plugin has its page; reference URLs and anchors are built only by `server/providers/links.ts`.

## Traps

- **A page recognises a service error by shape** (`isShareError(err, code)`, `isConnectError`), never `instanceof`: the page is bundled apart from the root that threw it, so `instanceof` can be false and the page answers 500 instead of "not found".
- **Self-contained documents** (consent screen, refusals of the forwarded request URL) are served under `default-src 'none'` by `server/http/document.ts`, which repeats the theme tokens (`document.test.ts` keeps them equal to `tokens.css`). Never relax that CSP to load the style sheet.
- The theme lives in the `vaubaan_theme` cookie, deliberately not `HttpOnly` and not `localStorage`: the server renders the right theme with no inline script, so nothing flashes.
- `LEGACY_REDIRECTS` never touches protocol paths: `/connections/callback/<provider>` (registered at providers), `/r/<id>` (handed to agents), `/mcp`, `/api`, `/oauth`, `/auth`, `/.well-known`.
- The bootstrap operator has a session but no user: a page needing a user renders `<NeedsUser />`, never a redirect.
- `catalogPathNextTo` joins a run-time path, so Turbopack traces the whole app directory (tests included) into every entry reaching it. Guards: `/* turbopackIgnore: true */` on the join (the only guard for the boot hook's trace) and `outputFileTracingExcludes` with `NEVER_SHIPPED` for routes; `tests/integration/standalone-plugin-catalogs.test.ts` checks it after a build.
- A client component takes rendered nodes from a server page, never a function; anything not marked client has no hook.
- `--ink-3` on a tinted surface is under AA: a tinted surface redefines it as `--ink-2` for its subtree.

## Procedures — adding a page

1. Place it under `(app)/`, `admin/(guarded)/` or `(public)/`, within one of the seven entries.
2. Authenticate first: `currentUser()` + `NeedsUser`, `requirePrincipal()` or `requireOperator()`.
3. Mutations are POST routes delegating to `src/server/<module>/handlers.ts`, which checks the origin, then the session; a message goes through the notice store, never the URL.
4. Build from the design system and the vocabulary, within the style guide's attention budget; look at it at 1440×900 and 1280×800 in both themes beside `/design`.
5. Add a bookmarked old path to `LEGACY_REDIRECTS`.
