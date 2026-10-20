---
title: The company's app created from the interface through the provider's manifest flow; every instance registers its own; the app's permissions declared once by the plugin
status: superseded
superseded-by: one-place-to-authorize-services-token-first
date: 2026-10-14
extends:
  - plugin-contract-and-credential-spec
---

# The company's app created from a manifest

## Context

Every self-hosted instance needs, per provider, an app registered by the
company (spec §4.3). For GitHub that is a GitHub App, and registering one by
hand is the longest step of an installation: a form at GitHub with a dozen
fields, a callback URL to copy, "Request user authorization (OAuth) during
installation" to tick, seven permissions to pick, a private key and a client
secret to generate, download and paste back into five fields.

A shared app published by Vaubaan would remove the step, and is ruled out
(the owner, 2026-10-14): the key of a GitHub App mints installation tokens
for **every** installation of that App. Shipped in every instance, it would
let any instance reach every other customer's repositories. Shared apps will
exist only in a future hosted service whose keys never leave Vaubaan ("the
Supabase model"). Each instance therefore registers its own apps, and that
must be easy.

GitHub offers the [App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
for exactly this. Checked on 2026-10-14 in GitHub's documentation, through
Context7 (`/github/docs`: `content/apps/sharing-github-apps/registering-a-github-app-from-a-manifest.md`,
`content/apps/creating-github-apps/registering-a-github-app/registering-a-github-app.md`,
`content/webhooks/types-of-webhooks.md`; `/websites/github_en`: REST "Create a
GitHub App from a manifest", "Permissions required for GitHub Apps", "List
branches", "Get branch protection"):

- the manifest is a JSON string in a form field named `manifest`, posted to
  `https://github.com/settings/apps/new` for a personal account or
  `https://github.com/organizations/ORGANIZATION/settings/apps/new` for an
  organisation, with an optional `state` query parameter returned unchanged;
- the person may edit the name, then confirms; GitHub redirects to the
  manifest's `redirect_url` with a temporary `code` (and the `state`);
- `POST /app-manifests/{code}/conversions` — which works with no token —
  answers the App: `id`, `slug`, `client_id`, `client_secret`, `pem`,
  `webhook_secret`, `owner`, `html_url`, `permissions`. **All three steps must
  complete within one hour**;
- manifest parameters: `name`, `url` (required, the homepage),
  `hook_attributes` (`url` required inside it, `active`), `redirect_url`,
  `callback_urls` (up to ten), `setup_url`, `description`, `public`,
  `default_events`, `default_permissions` (permission name → `read` /
  `write`), `request_oauth_on_install`, `setup_on_update`;
- with "Request user authorization (OAuth) during installation", no setup URL
  can be set: the installing person is sent to the callback URL;
- every GitHub App has one webhook, which can be inactive; an App that only
  authenticates needs none;
- listing branches needs Contents read, listing tags Metadata read, branch
  protection Administration, a change under `.github/workflows/` Workflows;
  Metadata read is granted to every App.

For installation tokens (REST "Create an installation access token for an
app", "Generating an installation access token"): the answer carries the
token's `permissions` (all the App's when none is asked); a token "cannot be
granted permissions that the app was not granted"; a refused request answers
422 "Validation failed". That a 422 is what a request for an ungranted
permission gets is our reading, not a sentence of the documentation: the push
token's fallback (Decision 4) treats any 422 that way, and a 422 with fewer
permissions is then declined by name.

## Decision

1. **Every instance registers its own company apps.** The spec says so
   (§4.3, §11.1, patch delivered with this ADR); no instance ever ships or
   accepts an app shared with another instance.

2. **The host runs a generic manifest flow, the plugin declares it.** An
   `app-install` `CredentialSpec` may carry `manifestRegistration`
   (`AppManifestRegistration`, plugin SDK): the permissions the app may
   request, the registration address per owner, the manifest builder, the
   code grammar and exchange endpoint, and the reader of the answer into the
   plugin's `appConfigFields`. The host (`AppRegistrationService`) names no
   provider. GitHub is the one shipped plugin that declares it.

3. **The flow.** On Settings → Administration → Company apps, a service that
   declares it and has no app set opens on "Create the <service> App"; the
   form by hand stays one click away. The administrator picks the owner (an
   organisation login checked against the plugin's grammar, or their personal
   account), the name (`Vaubaan <host>` by default, editable, at most 34
   characters for GitHub) and one level per permission.
   - The server checks the choice and builds the manifest: `url` = the public
     URL, `redirect_url` = `<public_url>/admin/provider-apps/<id>/created`,
     `callback_urls` = [the connection callback], `request_oauth_on_install:
true`, `public: false`, the chosen `default_permissions`. **No
     `hook_attributes` and no `default_events`**: the gateway receives no
     webhook (none of the plugin's tools needs one), so GitHub creates the
     App's webhook inactive. No `setup_url`: OAuth on install replaces it.
   - It stores the pending creation in the `SessionStore` under a `state` of
     32 random bytes, bound to the administrator's web session and to the
     provider, for **15 minutes** (inside GitHub's hour).
   - A confirm page (same session only) shows what will be created and one
     button that posts the manifest to GitHub — a page of its own, not an
     automatic post, so the administrator sees owner, name and permissions
     before leaving, and the flow needs no script.
   - On GitHub's redirect (a top-level GET: `guardSession`, operator), the
     state is **taken once** — deleted whatever follows — and must belong to
     this session and provider; a missing code means the administrator did
     not confirm; the code must match the plugin's grammar before it is put
     in a path; availability is checked again; the code is exchanged once,
     server to server, without a credential. The answer goes to
     `ProviderAppsService.saveRegistered`: the same validation and sealing as
     the form, in one transaction with a record of what the page shows (name,
     slug, owner, link, the permissions GitHub answered, who, when — never a
     secret). The webhook secret is not kept.
   - **Refused** when the configuration file sets the provider's app
     (read-only, as the form) and when any field is stored: replacing an app
     is the form's job, with its confirmation.
   - Every failure (state unknown, expired, of another session or replayed;
     cancelled; malformed code; GitHub's refusal, e.g. an expired or used
     code; GitHub unreachable; an unreadable answer) returns to the line as a
     plain one-time notice; nothing is stored.
   - **Audit**: one `config-changed` on `provider-app:<id>` — the shape of a
     form save plus `created_from: 'manifest'`, the App's name and slug, the
     owner, the permissions requested. Logs carry the provider, the owner and
     the status of a failed exchange; never a secret, the code included.
   - Afterwards the line shows the App (name linking to its GitHub page, the
     owner, the permissions) and the primary "Install it on your
     repositories", which is the existing connect flow. The record is shown
     only while the stored non-secret fields are those it was created with.

4. **The App's permissions are declared once, by the plugin, and enforced
   per call.** `GITHUB_APP_PERMISSIONS` lists, per GitHub permission, its
   levels and the tools each level serves (with `onlyWhen` for the needs that
   depend on arguments: a file under `.github/workflows/`, the push token).
   The page derives from it the default (every highest level: what the tools
   need), the sensitive marks (Contents write, Administration, Workflows,
   each with its reason) and "what stops a level down"; the manifest derives
   `default_permissions`; `execute` derives each call's needs and checks them
   against the `permissions` GitHub reports with the per-call installation
   token. A missing one is an `ExecutorRefusal` naming it — a typed decline,
   nothing sent — not GitHub's bare 403. Unknown permissions (a token cached
   by an older build) decline nothing. The push token asks for
   `pull_requests` and `workflows` too; on GitHub's 422 it is minted again
   with `contents: write` and `metadata: read` only; a second 422 is declined
   by name. This makes the App's permissions a hard ceiling an administrator
   can use where no branch protection exists (private repositories on a free
   plan).

## Consequences

- Installing a gateway on GitHub no longer involves copying a key: the first
  real use is the dogfooding instance, whose administrator creates the App in
  the `vaubaan` organisation from the page.
- A new provider with a manifest flow (none today) declares
  `manifestRegistration`; the host, the page and the audit need nothing.
- The confirm page is one click more than an automatic post; the flow
  survives a browser without script.
- An administrator who withholds a permission sees the tools that stop on
  the page, and agents get refusals that name the permission; a mission's
  permission (risk) and the App's permission are two different ceilings,
  both explicit.
- The e2e launcher stores the company's App instead of mounting it, so that
  a spec can remove it and create one through the flow.
- The created App belongs to the GitHub account that confirmed it; deleting
  or transferring it is done at GitHub. If the exchange fails after GitHub
  created the App, the App exists at GitHub without this instance holding
  its key; the notice says to delete it there and start again.

## Rejected alternatives

- **A Vaubaan-owned App shared by every instance.** One key reaching every
  customer's installations; reserved to a hosted service whose keys never
  leave Vaubaan.
- **Keep the form by hand only.** Correct but long and error-prone (the
  callback, the OAuth-on-install box, the permissions); it stays as the
  second way.
- **Post the manifest straight from the Company apps page** (the form's
  action at GitHub, the state drawn when the page renders). The address
  depends on the owner chosen in the same form, so it would need script, and
  a state would be drawn for every view of the page.
- **Auto-submit the confirm page.** Saves a click, hides what is about to be
  created, and needs script.
- **A webhook with `active: false`.** `hook_attributes` requires a URL; the
  gateway has none to give and needs no event. Leaving it out yields the same
  inactive webhook.
- **Probe the installation's permissions before each mint** (an extra token
  per call). The per-call token already reports them; the mint, which leaves
  the gateway, uses GitHub's own refusal instead.
- **A list of permissions in the page or in the host.** A second source of
  truth that would drift from the plugin's tools.
