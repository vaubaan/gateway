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
  - apps/gateway/src/lib/project-docs.ts
  - apps/gateway/src/lib/docs-links.ts
  - apps/gateway/src/server/config/docs-default.ts
  - apps/gateway/src/lib/theme.ts
  - apps/gateway/src/lib/auth/session.ts
  - apps/gateway/src/lib/http/
  - apps/gateway/src/app/(app)/design/
  - apps/gateway/src/server/now/
  - apps/gateway/src/server/http/document.ts
  - apps/gateway/src/server/services/
  - apps/gateway/src/lib/services/
  - apps/gateway/src/app/(app)/reference/
  - apps/gateway/src/server/plugins/service-page.ts
  - apps/gateway/next.config.ts
  - apps/gateway/src/app/manifest.ts
  - apps/gateway/public/sw.js
  - apps/gateway/src/components/notifications/
  - apps/gateway/tests/unit/app/
last_reviewed: 2026-11-15
---

# Web app — handbook

The frame of the human surface: layouts, session helpers, shell, words,
tokens, design system, home and reference. Each page's behaviour is in its
feature's handbook. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2,
[style-guide](../spec/style-guide.md); ADR
[interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md).

## Start here

- [`lib/auth/session.ts`](../../apps/gateway/src/lib/auth/session.ts) — `currentPrincipal`, `requirePrincipal`, `currentUser`, `requireOperator`: how a page gets its reader.
- [`components/shell/`](../../apps/gateway/src/components/shell/) — `AppShell`, `AdminShell`, the path bar, the navigation (`nav.ts`), the local tabs of Settings and Activity (`settings-nav.ts`, `activity-nav.ts`, drawn by `SubNav`).
- [`components/ui/`](../../apps/gateway/src/components/ui/) — the design system; each component's rule of use is in its header and on `/design`.
- [`lib/vocabulary.ts`](../../apps/gateway/src/lib/vocabulary.ts) — every word a person reads, keyed by the protocol name it translates.
- [`next.config.ts`](../../apps/gateway/next.config.ts) — `LEGACY_REDIRECTS`, what the standalone output traces and excludes.

## Invariants

- **Everything that decides is under `src/server/`**, host-agnostic (never imports `next`), except the pure rules a form runs before it posts (`src/lib/{authority,missions,services,shares}`), shared with the server and importing nothing from it; a client component imports only types from `@/server/` (**[inv: client-imports-no-server-value]**); a `route.ts` is one line over `root.<module>.handlers`. Pages are server components, `force-dynamic`, reading through `getRoot()`; the only browser `fetch` goes to `/api/**`, through `postJson` / `useAction` (`lib/http/post-json.ts`: one busy flag, one error, "The gateway could not be reached." in one wording).
- **A layout is navigation, never the authorization boundary**: the App Router can render a segment without its layout, so every page authenticates itself, first statement, before reading the root (`app-guard.test.ts`, `admin-guard.test.ts` discover every page and route). `src/proxy.ts` decides nothing: it sets the security headers and the CSP nonce.
- **A page shows what its service decides**: a control shown or hidden follows a rule written once next to the act and read from the view (`ownerActRefusal`, `gateEditBlockedBy`, `transferTargets`, `reassignTargets`); a page never re-spells it. `tests/integration/authority/rules-read-by-pages.test.ts` holds both sides.
- **A confirmation only before an irreversible act** (spec §4.2, owner decision 2026-11-14): `ConfirmSubmit` / `ConfirmDialog` / `DangerConfirm` guard deleting, stopping, replacing a key, removing an access or a person, disconnecting, finishing the setup, and the access that would bring stopped missions back (§7.3). Creating, editing and reversible switches (waiving a second factor, applying the admin rule, a permission request's editor) post at once: a busy button (`Button loading`), then the outcome on the next page (a callout or a toast); a 422 shows beside what it is about.
- **Seven navigation entries is the budget**: a feature adds no entry; a page under none goes in `ALSO_UNDER` (`nav.ts`). Ownerless accounts are an admin-only region of Accounts (`/accounts#without-owner`), shown only when one exists; the old admin page's path redirects there.
- **A disconnected account is never deleted**: the activity and the missions that ran on it still name it. On Accounts it leaves the table of yours for a closed `Disclosure` under it (`accounts-disconnected`); an empty `DataTable` renders its `empty` hint without its `testId`, so a spec checks the hint, not the table.
- **Mission cards speak in generic words only** (`CARD_WORDS`, `TRUST_LEVEL_CUSTOM`, `MISSION_LIST_FILTERS` in `vocabulary.ts`): what a card names comes from fields every plugin declares (`resourceNoun`, catalog labels, plane slugs) or the owner's environment labels — never a sentence written for one service ([missions](missions.md)). The (i) of a row and a gauge open on hover and on focus (`:focus-within`), so they work from the keyboard.
- **Under 641 px** the navigation is a bottom bar (Now, Waiting, Missions, Accounts, More with the other three), and a `DataTable` draws each row as a block of labelled lines; row actions are never hover-only.
- **Every date becomes text through `lib/dates.ts`**, locale-independent: no `toLocale*` or `Intl.DateTimeFormat` in a page (`lib/dates.test.ts` reads the sources). The server writes UTC; client components switch to the reader's zone after hydration.
- **The head of an approval** is the plugin's `toolTitles` and the refused call's `resource_ref`, never an argument. A yes is never given from the home: an approval row leads to its request, where the exact call is shown (`now-and-waiting.test.tsx`). Likewise a trust-raise proposal (`TrustRaiseOffer`, also on the mission page) never raises from the home: "Raise" opens Edit mission, "Not now" only puts it off.
- **Words live in `vocabulary.ts`** only, the trust levels' names and hints (`TRUST_LEVEL_LABELS`, `TRUST_LEVEL_HINTS`) included: a page never prints a protocol name as prose, it prints an id with `Mono`. Routes follow the words (`/accounts`, `/waiting`); `src/server/` keeps protocol names, except account and service, which the code and the protocol say as the interface does (ADR [one-word-per-thing-account-service-plugin](../decisions/one-word-per-thing-account-service-plugin.md)).
- **The words account, service and plugin replaced do not come back** in what a person or an agent reads: `vocabulary.ts`, the bootstrap text, `apps/website/content`, the site's landing and trust pages, the handbooks, the plugins' READMEs, catalogs, tool schemas, data models, credential guides, summaries and tool titles (`tests/unit/structural/one-word-per-thing.test.ts`, **[inv: one-word-per-thing]**). Connection keeps its unrelated senses (a TLS, SMTP, IMAP, SSH or database connection, a Git connection at Vercel) and the callback path registered at the services; provider is only the sign-in provider (identity provider), the OAuth provider of a broker and another product's term (Supabase's SSO providers); ADR slugs, migration names and retired keys keep theirs; the OAuth broker's own handbooks are allowed whole. The site's prose never credits "the <Name> plugin" with what the service lets an agent do. Each is an allowance with its reason; a new sense is added there, never by rewording around the test.
- **A page is built from `components/ui/`**: a missing component is added there with its specimen in `/design`, never in the page. Colours exist only in `tokens.css` as plain hex (`design-tokens.test.ts`: AA pairs, both dark blocks identical, no raw colour elsewhere). The one exception is a service's brand colour: it comes from its plugin (`ServiceIcon`), never a map in the interface, and reaches `ServiceMark` as `--mark-color`; a near-black brand turns to `--ink` in the dark theme (`darkThemeMarkColor` over `serviceMarkColors` of `@vaubaan/shared/service-mark`, WCAG luminance under 0.1 — the rule the public site draws with too).
- **A page explains itself through one table (doc hints)**: `PageHeader`'s `doc` draws an (i) after the title (`DocHint`, a `<button>` named "About <page>"), and a few concepts inside a form carry one too (trust levels, resources found later, environment labels). The (i) never navigates: hover (after 250 ms) and focus open a popover with the target's `label` in bold, its `hint` (1 to 3 sentences, at most `DOC_HINT_MAX` = 240 characters) and a last line "Documentation ↗" in a new tab — the only way out, on an explicit click; a click or a tap pins it (`role="dialog"`, non-modal; `role="tooltip"` otherwise), a second click, Escape or a press outside closes it, and `placeHint` keeps it inside the viewport. The open/close rules are the pure `hintReducer`. Testids: `doc-link` (or the one given) on the (i), `doc-hint` on the popover, `doc-hint-link` on the Documentation line. The target is an entry of `DOC_PAGES` or `serviceDoc(id, name, 'page' | 'connect', about)` in `vocabulary.ts`, never a text or a path in a page: a service's hint is its plugin's `description` (page) or `connectHint` (connect), cut by `clampHint`. The address is `docHref` (`lib/docs-links.ts`) under `docs.url` (default `DEFAULT_DOCS_URL`, `https://vaubaan.com/docs`; a service's page is the sibling `../plugins/<id>`). The root reaches client components through `DocsProvider`, rendered by `AppShell`; outside it (tests, the gallery) the hint shows its text without the Documentation line. `tests/unit/app/doc-links.test.ts` checks every hint's title and length, and reads `apps/website/content/docs` and the `plugins/` folders and fails when a path, its `meta.json` entry or a `#heading` anchor is missing, or the page is a generated one. A new page names its entry; a missing doc page is written on the site in the same pull request.
- **A page links a project document through `lib/project-docs.ts`** (`…/blob/main/…` addresses, the one repository URL shape `no-hardcoded-config.test.ts` admits); a page never spells the repository.
- **Every human page carries `BuildFooter`**, including the authorization server's HTML pages; one version source, the root `package.json`.
- **The interface is installable** (`app/manifest.ts`, named after the instance) and the shell registers `/sw.js` (`ServiceWorkerRegistration`); the worker shows notifications and opens pages, nothing else ([notifications](notifications.md)). A yes is never given from a notification either: it opens `/r/<id>`, the mission or the account.
- **The Reference is the plugin's page** (spec §4.2, [ADR](../decisions/service-page-is-one-shared-package.md)): `/reference/<id>` renders `ServicePage` of `@vaubaan/plugin-page` — the site's `/plugins/<id>`, sections 1–8 — over `servicePageInfo` (`server/plugins/service-page.ts`: `pluginInfo` of the registry's plugin, bundled or pinned, once per loaded plugin, screenshots at `/reference/<id>/connect/<file>`, examples `lenient`). The gateway hands in `titleLevel={2}` (under the frame's "Reference"), the (i) as `titleAside`, and `href` = `docsSiteHref` (`lib/docs-links.ts`: `/docs/…` under `docs.url`, `/plugins/<id>` back to the Reference, any other site path beside the docs root); it never puts anything inside the page: the instance's facts (the version it runs, pinned and what it replaces, the validation badge, the git remote) are the strip above it. The sheet `@vaubaan/plugin-page/plugin-page.css` is imported by that page and reads `--pp-*` only, mapped to the interface's tokens in `reference.module.css` (`.servicePage`), so it follows the theme. The page gives every permission `#risk-<id>` (its first chip shown before any toggle, else its row of Anything else or Retired) and every macro-action `#macro-<id>`; reference URLs and anchors are built only by `lib/services/links.ts`. `/reference` (the list) and the frame stay the gateway's (`lib/services/reference.ts`), each service with its mark and the plugin's description.

## Traps

- **A page recognises a service error by shape** (`isShareError(err, code)`, `isConnectError`), never `instanceof`: the page is bundled apart from the root that threw it, so `instanceof` can be false and the page answers 500 instead of "not found".
- **Self-contained documents** (consent screen, refusals of the forwarded request URL) are served under `default-src 'none'` by `server/http/document.ts`, which repeats the theme tokens (`document.test.ts` keeps them equal to `tokens.css`). Never relax that CSP to load the style sheet.
- The theme lives in the `vaubaan_theme` cookie, deliberately not `HttpOnly` and not `localStorage`: the server renders the right theme with no inline script, so nothing flashes. The home's "Not now" to notifications is the opposite case: one browser's convenience the server never needs, so it is `localStorage` (`vaubaan_push_not_now`).
- The CSP carries `worker-src 'self'` and `manifest-src 'self'`: with `'strict-dynamic'`, `script-src` no longer admits `'self'`, and a worker falling back to it would be blocked. Never add a `fetch` listener or a cache to `public/sw.js`.
- `LEGACY_REDIRECTS` never touches protocol paths: `/connections/callback/<service>` (registered at each service), `/r/<id>` (handed to agents), `/mcp`, `/api`, `/oauth`, `/auth`, `/.well-known`.
- The bootstrap operator has a session but no user: a page needing a user renders `<NeedsUser />`, never a redirect.
- `/activity` only redirects to its first tab (`/activity/record`), query kept, after the session check; `app-guard.test.ts` lists it in `REDIRECTING_PAGES`. An Overview tab later takes `/activity` itself: one entry first in `activityNav`, `exact`.
- `catalogPathNextTo` joins a run-time path, so Turbopack traces the whole app directory (tests included) into every entry reaching it. Guards: `/* turbopackIgnore: true */` on the join (the only guard for the boot hook's trace) and `outputFileTracingExcludes` with `NEVER_SHIPPED` for routes; `tests/integration/standalone-plugin-catalogs.test.ts` checks it after a build.
- A client component takes rendered nodes from a server page, never a function; anything not marked client has no hook.
- `--ink-3` on a tinted surface is under AA: a tinted surface redefines it as `--ink-2` for its subtree.

## Procedures — adding a page

1. Place it under `(app)/`, `admin/(guarded)/` or `(public)/`, within one of the seven entries.
2. Authenticate first: `currentUser()` + `NeedsUser`, `requirePrincipal()` or `requireOperator()`.
3. Mutations are POST routes delegating to `src/server/<module>/handlers.ts`, which checks the origin, then the session; a message goes through the notice store, never the URL.
4. Build from the design system and the vocabulary, within the style guide's attention budget; look at it at 1440×900 and 1280×800 in both themes beside `/design`. Give its header a `doc` from `DOC_PAGES` (add the entry, and the docs page when there is none).
5. Add a bookmarked old path to `LEGACY_REDIRECTS`.
