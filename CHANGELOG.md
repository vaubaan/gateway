# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public product name is **v2**; the repository's internal plan calls the
same work **v5** (see the pivot ADR). Tags are `v2.x.y`.

## [Unreleased]

### Added

- **A plugin version is activated without a restart.** Activating a newer (or a kept) version of
  an installed plugin runs its trial at once in the running instance: the next call of that service
  runs the new version, the sessions of every other service go on, and a call already running
  finishes on the version it started with. A version that fails its trial is never served: the
  previous one keeps serving and Administration › Plugins shows why. Plugins the image or the
  operator's plugins directory provide, and `plugins.safe_mode`, keep the trial at the next start.
- **Plugin versions are read from the catalog's index.** The versions check reads the catalog's
  `index.json` beside the versions feed: a plugin version the catalog published is offered at the
  next check, with its service's name, without a gateway release nor a site deployment. When the
  index cannot be read, the feed names the plugins as before.

### Changed

- **Miro (plugin 0.5.1): the tool list captured again.** Miro's descriptions of five tools are
  today's. Its new `content_search` is left out: it searches every board, space and call recording
  the person can open, beyond the mission's boards (agents keep `list_boards`). Tables, prototypes
  and blog posts stay modelled: Miro lists them only for a team that has those features, and the
  capture script now keeps a tool a team does not list (`--drop-gone` to remove one).

### Fixed

- **Vercel: an account scoped to one project reads its project and deployments** (plugin 4.2.2).
  Vercel's MCP server rejects a project-scoped token (`401 invalid_token`), so every rewrapped tool
  of a "One project" account failed. `get_project`, `list_deployments`, `get_deployment` and
  `get_deployment_build_logs` now go through the REST API for such an account, with the same
  names, schemas, classification and redaction; the other rewrapped tools are refused before any
  request, saying a team account runs them. `get_firewall_config` on a project without a firewall
  configuration (`404 Config not found`) answers an absent configuration instead of an error.
- **Vercel: a token scoped to one project connects again** (plugin 4.2.1). Vercel answers
  `404 Token not found.` when a project token asks for its own description
  (`GET /v5/user/tokens/current`), and the check read it first: every "One project" account
  failed at paste with a bare 404. The check now reads the project first, then the expiry, unknown
  for such a token.

## [2.0.0-alpha.28] - 2026-11-19

### Fixed

- **An instance on Fly or Railway starts again.** Since 2.0.0-alpha.27 the image compiles no
  service plugin, yet the start refused a self resource of a plugin not installed yet: every
  instance on Fly (`fly:$FLY_APP_NAME`, always added) or Railway (`railway:$RAILWAY_PROJECT_ID`)
  stopped with `'fly' is not a registered plugin id`, and so did installing any plugin at run time
  on an instance whose `self_resources` named one not installed. A self resource of a plugin the
  catalog offers is now accepted; it protects the resource from the moment the plugin is
  installed. An entry of a service the catalog does not offer still stops the start.
- **`plugins.enabled` naming a catalog plugin no longer stops the start.** Since 2.0.0-alpha.27
  the image compiles no service plugin, yet the start refused an id of `plugins.enabled` that was
  not installed yet (`'<id>' is not a plugin of this instance`): an instance upgraded with
  `VAUBAAN_PLUGINS_ENABLED=github` did not start, before the plugin its accounts need could be
  installed from the catalog. An id the catalog offers is now accepted and installed when first
  needed; an id the catalog does not offer still stops the start.

## [2.0.0-alpha.27] - 2026-11-19

### Changed

- **The image ships no service plugin.** Only the management plugin and `ssh` are compiled into
  the server; every other plugin comes from the catalog: installed when a person first connects
  its service, by an administrator, or pinned by the operator. A plugin fix is a catalog release,
  never a gateway release. On upgrade, a plugin the instance's accounts need is installed from the
  catalog at the first start, at the version this release knows (pinned by its sha256 and checked
  against the catalog's signature); without the catalog, the start stops naming it — pin the
  catalog's archive in `plugins.dir`.

### Removed

- The socle of 2.0.0-alpha.26 (catalog archives preinstalled in the image) and the per-plugin
  images `ghcr.io/vaubaan/plugin-<id>` with their `plugin-<id>-v<version>` tags: a pin is now a
  catalog archive unpacked (deploy/README.md, "Pin a plugin").

### Added

- **A plugin installs itself when a person first connects its service.** The connect picker also
  offers the catalog's plugins the instance does not have; choosing one asks to "Install and
  connect": the gateway downloads the catalog's version, keeps it only signed by Vaubaan, and loads
  it at once — no restart — for everyone on the instance. Any signed-in person may; the
  installation is audited. A plugin `plugins.enabled` does not name is refused.

## [2.0.0-alpha.26] - 2026-11-18

### Added

- **Install a plugin from the catalog in one click.** Administration › Plugins offers each plugin
  the versions feed says is behind, and each catalog plugin the instance does not have, with an
  "Install" button: the gateway downloads the version's archive from the catalog
  (`vaubaan/gateway-plugins` releases), keeps it only if it carries the catalog's signature and is
  that plugin at that version, and leaves it pending for an administrator to activate. The
  download is audited with where it came from. An upload of an id the versions feed names (a
  catalog plugin, shipped in the image or not) now needs the catalog's signature too.
- **Administration › Plugins says more before an activation.** The activation page names the
  active missions on the service, each linked; a kept version built for another SDK than this
  gateway's is shown with the reason and cannot be activated (its trial would fail); with
  `plugins.safe_mode` on, the page says installed versions are not running.
- **The image runs its default plugins from the catalog's signed archives.** The image build
  downloads the versions `deploy/socle.json` lists (the socle), each pinned by its sha256; at every
  start the gateway checks each archive's files and the catalog's signature, offline, and runs it in
  place of the compiled copy of that same version. An archive that does not verify is logged and
  the compiled copy runs. 19 of the 21 plugins come from the socle (`vaubaan` and `ssh` stay
  compiled).

- **A plugin author starts a project in one command.** `vaubaan-plugin init <dir> --id <id>`
  writes a standalone plugin project, outside the gateway's repository: the template plugin
  renamed to the id, its tests passing before any change (`npm run check`), and the instructions
  and skills a coding agent follows to model the service, write its risk catalog and classifier,
  and ship it. `vaubaan-plugin try <tool> [args]` decides one call without a gateway: the slices
  the classifier emits, the risks they touch and their gates under a sample mission, and the
  decision (exit 0 only when allowed). `vaubaan-plugin deploy --gateway <url>` hands the built
  archive to a gateway through its MCP door, with the token of a mission an administrator issued
  with "Install plugins" (`VAUBAAN_MISSION_TOKEN`), and prints where to activate it; it never
  activates. `vaubaan-plugin submit` declares the project's pushed commit to the public catalog
  (vaubaan/gateway-plugins) and opens the pull request with `gh`; `--dry-run` only prints the
  declaration. `@vaubaan/plugin-cli` and `@vaubaan/plugin-sdk` are ready for npm, published by
  `publish-plugin-kit.yml` through npm trusted publishing (no token), each version tried first
  outside the repository the way an author installs it.

- **An administrator installs a plugin from Administration › Plugins.** Upload the archive
  `vaubaan-plugin build` writes (`.tgz`, now packed beside its folder): it is checked without
  running any of its code and stays inert. Activating it, by typing the plugin's id after reading
  the permissions it adds or deprecates, takes effect at the next start, **on trial**: a version
  that does not load, or whose own examples do not classify, gives way to the previous one and the
  instance starts. An administrator goes back to a kept version (the active one, two previous, and
  the image's), refuses a pending one, lets a plugin follow the image again, and restarts the
  instance (exit 75, for the supervisor). Every act is audited. Archives live beside the store
  (`<data dir>/plugins/<sha256>`, migration 0041) and are checked against their manifest at every
  start. Until signatures are verified, only the ids of the new `plugins.allow_unsigned` can be
  installed, never an id of the image. `plugins.safe_mode` starts without any installed plugin.
  A mission keeps saving a permission only a kept newer version knows.
- **An agent hands over the plugin it built (plugin `vaubaan` 0.5.0).** Two tools join the
  platform management mission, in a new macro-action **Install plugins**:
  `vaubaan__upload_plugin` (risk `vaubaan.plugin-upload`, asks first at Careful) uploads an archive,
  which stays pending and answers the address where an administrator activates it, and
  `vaubaan__plugin_status` (risk `vaubaan.plugin-read`) lists the plugins the instance runs and every
  installed version. Both are refused (`administrator-only`) unless the mission's creator is an
  administrator; no tool activates, rolls back or removes a plugin. A platform mission issued
  before gains them only when its creator edits it.
- **A plugin is signed with a company key.** `vaubaan-plugin keygen` makes an ed25519 key pair,
  `vaubaan-plugin sign <archive> --key <file>` writes `vaubaan-manifest.json.sig.json` (the
  signature of the manifest, named by the key's id) and packs the `.tgz` again, and
  `vaubaan-plugin pack` packs a folder once a signature was added beside its manifest. The format
  is `@vaubaan/plugin-sdk/archive`'s.
- **The gateway verifies who signed a plugin.** An archive of the catalog,
  [vaubaan/gateway-plugins](https://github.com/vaubaan/gateway-plugins), is signed keyless by its
  release workflow and verified **offline** against the Sigstore trusted root this release embeds:
  the certificate must name that workflow on main, GitHub's issuer and the catalog repository's
  id, compared exactly. Such an archive is shown "signed by Vaubaan" and may replace a plugin of
  the image. A company key's signature counts once an administrator trusts it under
  Administration › Plugins › Trusted signers (typed name, every administrator notified, audited);
  a removed signer turns away what it signed at the next start. An unsigned archive installs only
  for an id `plugins.allow_unsigned` names, never for an id of the image. The versions feed
  compares only what Vaubaan signed. Migration 0042 (`plugin_signers`).

### Fixed

- An uploaded archive refused at upload no longer deletes the folder of an installed version
  with the same bytes.

- **GitHub (plugin 5.3.1): the first push to an empty repository goes through.** A repository
  created without a README has no branch, yet GitHub names a default branch; the review compared
  the push with that missing branch and refused it ("no history in common with main"). With no
  branch at GitHub, a new branch is now reviewed as a creation: every file of its tip and every
  commit of its history (at most 100 commits and 299 files; beyond, push an earlier commit first).
  A push whose history shares nothing with an existing branch is still refused, and the refusal
  now says what to do: fetch the branch and rebase onto it.

### Changed

- **Base images** `node:26.13.1-bookworm-slim` and `caddy:2.11.9-alpine`, each pinned by its
  multi-architecture digest.

## [2.0.0-alpha.25] - 2026-11-17

### Added

- **GitHub (plugin 5.3.0): `github__update_issue` edits an issue's title, body or type.** An absent field is left
  unchanged, an empty body clears the description, `type: null` removes the issue type. It
  answers the issue as it now reads, type included (GitHub ignores a type change without push
  access). New risk `github.issue-write` (slice `issue[N].edit.W`), in the macro-action `propose`
  (catalog version 15). Token permission: Issues (read and write), already asked. Missions issued
  before gain it only when their creator edits them.
- **A plugin is written and built outside this repository.** `npm pack` of `@vaubaan/plugin-sdk`
  now carries `@vaubaan/shared` and `@vaubaan/policy-engine` inside it, so the tarball installs in
  an empty directory and a plugin compiles and runs its tests against it. A new package,
  `@vaubaan/plugin-cli`, builds a plugin's archive (`vaubaan-plugin build`) under the plugin's own
  name and licence, with `vaubaan-manifest.json`, the sha256 of every file; the repository's
  plugin bundles are built by it too. Neither package is published yet.

### Security

- **Next.js 16.4.6** (from 16.4.3), for GHSA-mfr8-8qww-v76h (moderate: information disclosure
  across root params through `unstable_cache()` and `'use cache'`). The gateway and the website
  use neither, so no instance was exposed; `next build` refused to run on the affected version.

## [2.0.0-alpha.24] - 2026-11-16

### Added

- **An agent renames and edits missions (plugin `vaubaan` 0.4.0).** Two tools join the platform
  management mission: `vaubaan__rename_mission` (risk `vaubaan.mission-rename`) and
  `vaubaan__edit_mission` (risk `vaubaan.mission-edit`), both in **Prepare missions**. At Careful a
  rename runs freely and an edit asks the person first, like issuing. An edit is the creator's own
  "Edit mission": same key, one version in the History marked as made by the calling mission,
  within the creator's authority and refused whole beyond it. `vaubaan__preview_policy` takes an
  optional `mission_id` to preview an edit, and `vaubaan__list_my_missions` with `mission_id`
  answers the mission as a `draft` to edit. A mission never renames nor edits itself, and an edit
  never adds a Vaubaan account. A platform mission issued before gains these risks only when its
  creator edits it.

### Changed

- **A mission's keys come first, with every act on a key.** The section "People and keys" is
  now **Keys** and sits before the permissions. Its creator's one entry is **Add keys**: one
  dialog to add a teammate (a person who signed in; they generate their own key) or to create
  a machine key (named, shown once). Generate, replace and revoke your key are on your row; the
  "···" menu keeps activity, duplicate, leave and stop. The post-issuance page's "Add teammate"
  and "New machine key" open that dialog on the mission page; old `#people` links still land.
- **The "···" menu is visible.** Its button is drawn like its neighbours (bordered, same size),
  on every page, in both themes.

### Fixed

- **One Vaubaan account per person, held by the store.** Two connects at once could store two
  Vaubaan accounts for one person; the store now refuses a second one whatever path writes it,
  and connecting again still hands back the account the person holds. **Operators: this release
  carries migration 0040 (schema 40)**, applied at boot. On an instance that already holds such
  duplicates, it keeps each person's oldest active Vaubaan account and disconnects the others
  before creating the index. Their missions are not moved: the disconnected account's part of
  each is lost, as after any disconnect, and a platform management mission that held only that
  account stops serving until its creator edits it onto the kept account or issues a new one.
  Each disconnect is in Activity, by "A gateway upgrade", naming the kept account and the
  missions concerned. Instances without duplicates see no change.

## [2.0.0-alpha.23] - 2026-11-16

### Changed

- **A lost account says so in its own card, and its creator removes it.** When an account of a
  running mission no longer serves it (disconnected, an access withdrawn), the mission page no
  longer shows a banner: the account's card turns red and folds to one line ("“vps-rp-skills”
  was disconnected by its owner; calls through it are refused."), its details one click away.
  Edit mission now shows that card with **Remove from mission**; saving is an ordinary edit,
  one version in the History. Nothing removes or hides a lost account on its own, and
  restoring a version neither brings a removed one back nor takes a lost one out.
- **GitHub 5.2.0: one repository per account, named on the connect form.** A fine-grained
  token reads every public repository and GitHub cannot list a token's own grant, so the form
  now asks the repository (`owner/repo`); the check at paste opens it (a 404 is refused) and
  discovery answers that repository alone. Accounts connected before keep the former listing
  until they are reconnected with their repository. A mission holds one account per service,
  so one GitHub repository per mission.

### Added

- **GitHub Projects plugin** (`@vaubaan/plugin-github-projects` 0.1.0): one organization
  project per account, with a fine-grained token; read the board, add cards, change their
  fields, remove them, create fields and views. Macro-actions `read`, `track`, `remove`,
  `shape`.
- **Notification "an account no longer serves your mission"** to the mission's creator, on
  their channels (Web Push, messaging addresses, mail), when someone else's act took the
  account from a mission that keeps running.

## [2.0.0-alpha.22] - 2026-11-15

### Added

- **Activity's Overview, and the bytes of every forwarded call** (spec §4.2 Activity, §8).
  `/activity` is now the Overview, first tab before the Record and the Timeline (an older
  `/activity?<Record filters>` address still opens the Record). Per mission of the
  Timeline's scope, over today, 7 or 30 days: calls allowed and refused, requests waiting,
  bytes sent and received; behind a disclosure, the requests per account, the use per action
  in the current period and the key holders with their share; above them, what stops working
  within 7 days (a mission's end, a pasted key's end, an account its service refused), each
  linked to where it is fixed. Every number opens the Record or the Timeline filtered on it.
  The pipeline now counts the bytes of a forwarded call (MCP: arguments and result as JSON;
  git: the relayed request and pack of a fetch, the pack of a push). Migration 0038 adds
  `audit.request_bytes`, `audit.response_bytes` (nullable, older entries stay empty) and a
  covering index for the Overview.
- **The History of a mission, and restoring a version** (spec §4.2 "History"). Every change
  of a mission's configuration — issuance, edit, permission request accepted, created
  resource joined, future resources joining or leaving, gate and limits, a claim's new end —
  writes one immutable, numbered version (author, cause, the whole configuration, what
  moved). The mission page lists them newest first, with what changed one click away; the
  creator restores a past version at once, as a new version, bounded by their authority
  today (what they no longer hold is left out and said). Keys, teammates and counters are
  not part of a version. Versions are kept as long as the mission, never by the audit's
  retention. Migration 0039 adds `mission_versions` and writes every existing mission's
  version 1 from its current state. `POST /api/missions/:id/versions/:number/restore`.
- **Accounts refresh themselves.** Every active account (and any a running future set
  depends on) refreshes its resources and its key's rights once per
  `accounts.refresh_interval` (new key, default `1h`, `15m` to `24h`, `0` turns it off;
  `VAUBAAN_ACCOUNTS_REFRESH_INTERVAL`), each at its own slot of the interval, one after the
  other, a failure backing it off 1, 2, 4 then 8 intervals. The account page, the Accounts
  list and the mission form also refresh, in place, the accounts last refreshed more than
  15 minutes ago (`POST /api/accounts/refresh`). A refresh is audited only when it changed
  something. "Updated 12 min ago" replaces "Found".

### Changed

- **The Reference of a service is its plugin page.** The gateway's `/reference/<id>` renders
  the same page the site shows at `/plugins/<id>`, from one shared package
  (`@vaubaan/plugin-page`, ADR service-page-is-one-shared-package), built from the plugin
  this instance runs (bundled or pinned), its links under `docs.url`; a strip above it gives
  the version, a pinned tag, the validation badge and the git remote. Anchors `#risk-<id>`
  and `#macro-<id>` stay.
- **The (i) explains where you are, in a hint.** The (i) beside a page title or a concept no
  longer opens the docs in a new tab: it shows a small popover (on hover or focus, pinned by
  a click or a tap) with one to three sentences of context and a "Documentation ↗" line,
  the only way out to the docs.

### Breaking

- **Provider is service, in the code, the store and the protocol; the sign-in provider says
  so** (ADR one-word-per-thing-account-service-plugin, rename R2). GitHub, Vercel or Gmail
  is a service everywhere a person, an agent or an integration reads it; provider is left to
  the sign-in provider people sign in through and to the OAuth provider of an OAuth broker.
  Old → new:
  - plugin `vaubaan` 0.3.0, `vaubaan__get_catalog`: argument `provider` → `service`; its answer’s `provider`,
    `provider_label` → `service`, `service_label`; refusal `unknown-provider` →
    `unknown-service`, its list `providers` → `services`;
  - `vaubaan__list_my_accounts`: each account’s `provider`, `provider_label` → `service`,
    `service_label`;
  - `vaubaan__preview_policy` and `vaubaan__issue_mission`: an account named by `provider` →
    `service`; issue code `duplicate-provider` → `duplicate-service`; `uncovered[].provider`
    → `service`;
  - the execution door’s catalog (`tools[].provider`, `accounts[].provider`) → `service`;
  - an account’s fields `provider`, `provider_label`, `provider_icon`, `provider_grant` →
    `service`, `service_label`, `service_icon`, `service_grant`; an approval’s
    `provider_pages` → `service_pages`;
  - connect errors `provider-unknown`, `provider-denied`, `provider-unreachable`,
    `provider-mismatch` → `service-…`; a share’s `provider-unknown` → `service-unknown`; the
    v4 import’s `provider-not-shipped` → `service-not-shipped`;
  - sign-in errors `provider-unknown`, `provider-disabled`, `no-local-provider` →
    `sign-in-provider-unknown`, `sign-in-provider-disabled`, `no-local-sign-in-provider`;
    the forms of Settings › Sign-in, People and the recovery page post `sign_in_provider_id`
    / `sign_in_provider`;
  - plugin SDK 0.9.4: `ServicePlugin`, `ServiceLabel`, `serviceForTool`, the catalog and data
    model’s `service`, a slice’s and a resource’s `service`, the token expiry
    `service-reports`. `ProviderPlugin`, `ProviderLabel` and `providerForTool` stay as
    deprecated aliases until 0.10, a catalog that still writes `provider:` loads, and a
    plugin pinned from an earlier SDK is read in the new words (`fromLegacyPlugin`). The
    OAuth broker’s `broker: { provider }` keeps its name: it is the broker protocol’s.

  Store migration 0037 renames `accounts.provider` → `service`, `accounts.provider_grant` →
  `service_grant`, and the sign-in provider of groups, administrators, sign-in accounts and
  their links → `sign_in_provider`, in place; it rewrites the audit’s JSON snapshots (a
  service’s `provider…` → `service…`, a sign-in provider’s `provider` → `sign_in_provider`),
  the session events, the requests’ decisions and the web sessions (nobody is signed out).
  No id and no sealed byte changes. A backup written before the upgrade restores. The site’s
  `/docs/providers` is `/docs/services` (the old addresses redirect). Kept on purpose: the
  OAuth broker’s wire and its `providers` key, the retired keys `providers.<id>.*` and
  `VAUBAAN_PROVIDER_*`, and the telemetry payload, which never carried the word. No
  configuration key changes.

### Plugin SDK

- **0.9.4 — `ServicePlugin` and the word service** (ADR
  one-word-per-thing-account-service-plugin, rename R2): the plugin contract, its label, the
  registry's `serviceForTool`, the `service` of a catalog, a data model, a slice and a resource,
  and the token expiry `service-reports`. `ProviderPlugin`, `ProviderLabel` and
  `providerForTool` stay as `@deprecated` aliases until 0.10, the catalog loader reads a
  `provider:` key as `service:`, and `fromLegacyPlugin` reads a plugin of an earlier SDK in the
  new words both ways: a pin built against 0.9 loads as before.

## [2.0.0-alpha.21] - 2026-11-14

### Breaking

- **Connection is account, in the code, the store and the protocol** (ADR
  one-word-per-thing-account-service-plugin). The interface already said account; the tool
  names, refusal codes, API fields and audit acts an agent or an integration reads now say it
  too. Old → new:
  - tool `vaubaan__list_my_connections` → `vaubaan__list_my_accounts` (plugin `vaubaan` 0.2.0); its answer’s
    `lost_connections` → `lost_accounts`;
  - refusal codes `connection-unavailable` → `account-unavailable`, `connection-revoked` →
    `account-revoked`;
  - fields `connection_id` → `account_id`, `connections` → `accounts` (an issuance, a preview,
    `vaubaan__issue_mission`, the audit, the session events),
    `connection_ids` → `account_ids`, `connection_index` → `account_index`,
    `connections_added` / `connections_removed` → `accounts_added` / `accounts_removed`,
    `connections_unowned` → `accounts_unowned`; the resource scope `{ scope: 'connection' }`
    → `{ scope: 'account' }`;
  - preview and issuance issue codes `connection-unknown`, `connection-ambiguous`,
    `connection-unavailable`, `connection-personal`, `duplicate-connection`, `no-connection`,
    `unknown-connection`, `resource-not-in-connection` → the same with `account`; connect
    errors `connection-limit-reached`, `connection-unowned`, `connection-name` → `account-…`;
  - audit acts `connection-created`, `-reconnected`, `-refused`, `-transferred`,
    `-reassigned`, `-revoked`, `-default-env-set` → `account-…`; `mission-connection-lost` /
    `-restored` → `mission-account-lost` / `-restored`; object type `connection` → `account`;
  - sign-in: `local-account-created` / `-removed` → `sign-in-account-created` / `-removed`,
    their object `local-account:<provider>` → `sign-in-account:<provider>`; the pages
    `/account/create|reset|forgot` → `/sign-in-account/…` (the old paths redirect, so a link
    mailed before the upgrade still opens) and their forms post to `/api/sign-in-account/…`.

  Store migration 0036 renames the tables (`connections` → `accounts`, `connection_resources`
  → `account_resources`, `mission_connections` → `mission_accounts`, `local_accounts` →
  `sign_in_accounts`) and every `connection_id` column in place, and rewrites the stored acts,
  refusal codes and JSON snapshots to the new names: history reads with them. No id and no
  sealed byte changes: every credential still opens. A backup written before the upgrade
  restores. Kept on purpose: the callback `/connections/callback/<plugin>` registered at
  the services and the brokers, and the telemetry payload (`connection-revoked` and
  `connection-unavailable` still travel under those names). `limits.connections` and
  `VAUBAAN_LIMITS_CONNECTIONS` are read as `limits.accounts` / `VAUBAAN_LIMITS_ACCOUNTS`,
  with one warning at start. The sign-in provider kind stays `local`.

### Changed

- **No confirmation except before an irreversible act** (spec §4.2, owner decision
  2026-11-14). "Create mission" creates at once and shows the key: the recap of the explicit
  list is gone (the mission page shows that list read-only, the server checks it again).
  "Save changes" saves at once and lands on the mission page with its "Saved" callout: the
  before → after recap is gone. A permission request's editor saves without a review dialog;
  waiving or asking again the second factor of a sign-in provider and applying the
  configuration's admin rule post at once. Stopping, removing, replacing a key, disconnecting
  and finishing the setup are still asked first.
- **The mission form ticks no resource by itself unless the group holds one**; "Select all"
  ticks the others. Resources hidden from new missions are collapsed under "Hidden from new
  missions (n)" and never ticked — they were listed and ticked before, unlike
  `{ scope: 'all' }`.
- **GitHub 5.1.0: public repositories are discovered hidden from new missions.** A
  fine-grained token reads every public repository, and GitHub cannot list a token's own
  repositories: a public repository is listed hidden until the account's owner shows it
  (handbook providers/github, "Repositories outside the grant"). A resource the owner hid or
  showed keeps that choice across refreshes (store migration 0034, `hidden_edited`).

- **Agents prepare missions through a plugin, `vaubaan`, on the execution door; the
  management door, its OAuth authorization server, delegations and Settings › Connected
  apps are retired** (ADR platform-management-is-a-plugin-on-the-execution-door). A
  person connects their Vaubaan account in one click, creates the platform management
  mission the account page offers (every macro-action at Careful) and gives its key to
  the agent, which calls `vaubaan__list_my_accounts`, `vaubaan__issue_mission` and the
  five others on `/mcp` — same arguments and answers as before, but for `issued_via`,
  which names the issuing mission. A mission never rotates nor revokes itself, and a
  mission it issues never holds a Vaubaan account. `/mcp/manage` answers 404 with a
  hint. Migration 0035 drops the OAuth tables and keeps every mission and its key; the
  `oauth.*` keys are ignored with one warning at start.

### Plugin SDK

- **0.9.3 — `AccountContext` and `ClassifyAccount`** (ADR
  one-word-per-thing-account-service-plugin): the context of `verify`, `discoverResources`,
  `refresh` and `revoke`, and the public fields `classify` receives, named after the account.
  `ConnectionContext` and `ClassifyConnection` stay as `@deprecated` aliases until 0.10, and
  the kit's `decide` still reads `connection` beside `account`: a pin built against 0.9
  loads and compiles as before.

- **0.9.2 — the credential kind `host`**: no field, nothing to paste or verify; only the
  gateway creates such an account, and a plugin declaring it is loaded bundled only (a
  pin declaring it is refused at boot). Nothing changes for a plugin that does not
  declare it.

- **0.9.1 — `Resource.hiddenByDefault?`**: a discovery's hint that the credential most likely
  cannot act on a resource; the host lists it hidden until its owner chooses (ADR
  connect-driver-and-resource-curation, amendment 2026-11-14).

## [2.0.0-alpha.20] - 2026-11-13

### Plugin SDK

- **0.9.0 — the risk vector has five facts; a minor because the catalog loader refuses
  what 0.8 accepted** (spec gateway-risk-model §4.2, ADR
  macro-actions-and-trust-levels-prefill-the-policy, amendment 2026-11-13). A
  `persistence` key in a `vector` or a `vector_overrides` entry is an unknown axis, with a
  hint to remove the line; a pin built against 0.8 (`^0.8.0`) is turned away until it is
  rebuilt with its catalog's `persistence:` lines removed. `RiskVector` loses
  `persistence`. The test kit (`@vaubaan/plugin-sdk/testing`) exports `rowOf` and
  `reasonOf` in place of `tierOf`.

- **0.8.0 — the connect guide: menu paths and screenshots with their provenance; a
  minor because `definePlugin` now refuses what 0.7 accepted** (a malformed `path`, a
  screenshot without a source, a licence outside the allowlist, a step naming an
  undeclared file), and before `1.0.0` such a rule is a minor. A pin built against 0.7
  (`^0.7.0`, `^0.7.1`) is turned away until it is rebuilt (ADR
  plugin-contract-and-credential-spec, amendment 2026-11-13).
  - `GuideStep.path?: string[]`: the menus the person follows at the provider, in its
    own labels (1 to 8, at most 40 characters each); the sentence `do` no longer
    carries them. The connect page and the site draw them as highlighted chips.
  - `GuideStep.screenshot?` and `TokenGuide.screenshots?`: one picture of the hard
    screen, a `.png` or `.webp` in `docs/connect/` of the plugin folder
    (`GUIDE_SCREENSHOT_DIR`), declared with `source` (the https page it comes from, or
    `ours`), `licence` (`CC-BY-4.0`, `MIT`, `Apache-2.0` or `ours`: no NonCommercial, no
    NoDerivatives), `taken` (`YYYY-MM`) and `alt`; every declared file named by one
    step. `screenshotAttribution(service, screenshot)` derives the line under the
    image, the same on the site and the gateway.
  - `guideText(guide, alternatives?)` reads the paths too.

### Added

- **The connect guide, one declaration in three places** (website spec §2.3 item 7):
  the plugin page of vaubaan.com carries the whole guide in its section "Connecting
  an account" — the kind badge (1 of 3 · a key you create and paste, 2 of 3 · you
  sign in and allow the gateway, 3 of 3 · you sign in through an OAuth broker), the
  menu paths as highlighted chips, the screenshot of the hard screen with its
  provenance line, permissions, expiry and fields; `/docs/providers/<id>` now
  redirects there (`/plugins/<id>#connect`). The gateway's connect screen draws the
  same paths and screenshots, served from the plugin's folder, bundled or pinned
  (`GET /reference/<id>/connect/<file>`, signed-in users). Every guide step carries
  its menu path; Cloudflare DNS shows the Create Token form from Cloudflare's own
  documentation (CC BY 4.0). The plugin bundle carries `docs/connect/`.

### Changed

- **The gate of a permission comes from a decision tree over five facts; the severity
  word is gone** (spec gateway-risk-model §4.2, §4.6; ADRs
  macro-actions-and-trust-levels-prefill-the-policy and
  interface-redesign-vocabulary-and-design-system, amendments 2026-11-13). A permission
  sits in the first row its facts answer: irreversible → **Cannot be repaired**; costly
  to undo or unbounded cost → **Repairable, at a price**; secret or personal data, whole
  account or bulk, moderate cost, public → **Repairable, worth a look**; otherwise
  **Harmless**. The branch that decided is its reason, shown in quiet type. The gateway
  and vaubaan.com print the row and its reason where they printed low / medium / high /
  critical, order lists by row (the hardest to repair first, then catalog order), and say
  "the hardest to repair" where they said "the most severe". The five facts stay behind
  "why?" in the Reference only. The gates of each row at each trust level do not change.
  Every shipped catalog drops its `persistence:` lines (a new `catalog_version`, dated
  2026-11-13; no risk, pattern or macro-action changed).
- **Behaviour change of the pre-filled gates.** These lines move from row 1 to row 2, so
  a macro-action ticked at Careful now writes them `approval` (Trusting and Autonomous
  unchanged): Fly `machine-create`, `machine-power`, `volume-create`,
  `volume-backup-settings`, `volume-snapshot`, `ip-write`, `certificate-write`; Railway
  `deploy` (staging, preview, dev); SSH `exec-service-control`; Stripe `read-catalog`;
  Vercel `deploy` (preview, development), `fetch-deployment-url`, `firewall-write`,
  `firewall-rule-write`, `ip-rule-write`. `fly.scale` moves from row 2 to row 3: it now
  asks first at Careful and at Trusting. Missions already issued keep their explicit
  lines; only a newly ticked or re-ticked macro-action writes the new gate.
- **Context7: `query-docs` is a documentation read** (catalog_version 5): its vector was
  "irreversible" (the question cannot be recalled), which put a read in "Cannot be
  repaired" and left it out at Careful. It is now reversible, single, data, free,
  internal: it runs freely at every trust level; the disclosure of the question stays in
  its reason.
- **Management door: `get_catalog` answers `row` and `row_reason`** for each risk instead
  of `level` and `tier`; `trust_levels.*.gates` keeps its keys `'1'`…`'4'`, now rows. The
  `everything-i-hold-expanded` notice names the risk hardest to repair and the row-4
  risks running freely.
- **`/plugins.json`**: each permission carries `row` and `row_reason` (per environment in
  `env_variants` too) instead of `severity` and `tier`, and its `vector` has five facts;
  the worked mission's lines and left-out risks carry `row`.
- **The connect screen lists the permissions to tick without their tools**: each
  permission by name and access ("read and write" when any declaration writes), no
  longer "for <tools>". The tools stay in the plugin's declaration (coverage).
- **GitHub: the guide asks for the repositories the missions will use**, "Only select
  repositories", instead of "All repositories" (ADR
  one-place-to-authorize-services-token-first, amendment 2026-11-13). The other guides
  keep their wide grant until reviewed.
- **vaubaan.com plugin pages in the "Atlas" layout** (website spec §2.3): ten sections,
  each heading a fixed template over plugin fields. **The model** draws the plugin's data
  model as nested boxes — the account, each plane, the resource entity highlighted, the
  entity carrying the environment, cardinality marks, entities no tool touches dashed, each
  description behind an (i) — with the Account / Resource / Environment callouts.
  **Macro-actions** are cards. **The map** puts every permission in its row of the tree
  by macro-action, with a trust-level toggle (Careful ×1 / Trusting ×3 / Autonomous ×10)
  and, where the data model carries an environment, an environment toggle: each cell says
  yes / ask me / no and the quota a day, an environment the catalog refuses reads "no ·
  never on prod", dashed. **A few calls** shows one declared example per macro-action and
  the first refused at Careful. Tools sit in a scrolling box; the connect guide shows a
  key's alternatives (Vercel: team or one project) as a toggle, each with its own steps
  then the shared ones, and the grants as "Permission at <service> · Access". All toggles
  are CSS-only radio groups: every state is in the HTML. Gone: the worked mission, the
  per-macro-action tables, the fact chips. The Markdown twin follows the same order (the
  model as an outline, the map as one list per row with every level and environment).
  `/plugins.json` adds `data_model`, `environment` and each way's `alternatives`; a
  way's `steps` are now the guide's shared steps only.

## [2.0.0-alpha.19] - 2026-11-13

### Plugin SDK

- **0.7.1 — alternatives of a pasted key** (ADR plugin-contract-and-credential-spec,
  amendment 2026-11-11). `ApiKeyCredentialSpec.alternatives?: CredentialAlternative[]`
  (2 to 4 `{ id, label, help?, fields, steps }`): the connect page asks the person to
  choose one, shows its steps before the guide's own, and keeps only the shared fields
  and the chosen alternative's; `definePlugin` checks ids, labels, steps, that each
  field belongs to one alternative at most and that each alternative asks a secret.
  `guideText(guide, alternatives?)` reads the alternatives' steps too. An optional
  member: a patch.

### Added

- **Vercel: a token scoped to one project** (plugin 4.2.0; ADR
  one-place-to-authorize-services-token-first, amendment 2026-11-11, reversing the
  2026-10-31 refusal). The connect form offers "Team" (token + Team ID) or "One
  project" (token + Project ID). A project account is checked against
  `GET /v9/projects/{id}`, named after the project, discovers that project alone,
  sends the REST API no team and refuses every `teamId` argument and every other
  project. Team accounts are unchanged and need no reconnection; a team token
  refused the team now says it may be scoped to one project, and an unknown Team ID
  says so instead of blaming the scope.

## [2.0.0-alpha.18] - 2026-11-11

### Plugin SDK

- **0.7.0 — narrative, excludedTools, examples; a minor because the loader and
  `definePlugin` now refuse what 0.6 accepted** (a malformed `narrative`, an
  `excludedTools` name that is a declared tool), and before `1.0.0` such a rule
  is a minor. A pin built against 0.6 (`^0.6.0`) is turned away until it is
  rebuilt. A plugin declares what its public page shows (ADR
  plugin-contract-and-credential-spec, amendment 2026-11-05).
  `ProviderPlugin.excludedTools?: Record<toolName, reason>` names the tools of
  the provider the plugin deliberately leaves out, one sentence each
  (`definePlugin` refuses a name that is a declared tool);
  `ProviderPlugin.examples?: ToolSamples` holds the tool samples, which
  `assertCatalogCoverage(plugin)` now uses when no samples are passed.
  `SampleCall` and `ToolSamples` are exported from `@vaubaan/plugin-sdk` (still
  from `/testing`). A catalog macro-action may carry a `narrative` (two to four
  sentences, at most 600 characters, spec gateway-risk-model §4.6); the loader
  refuses one that is not a non-empty string within that length.

### Added

- **vaubaan.com plugin pages in the C3 layout** (website spec §2.3): the
  opening with the counts and the macro-actions in one sentence; the map, every
  permission by macro-action and undo row (impossible, costly, easy but
  sensitive, easy), tinted by its risk word, each row saying what the trust
  levels do, with a reading sentence computed from the counts; one spread per
  macro-action (narrative, the permissions against the three trust levels with
  the six facts, the fact that moves the gate tinted, the gate and quota a day,
  the rates as a note, an environment-scoped permission one line per
  environment, the macro-action's own column of the map beside it); the worked
  examples; Anything else and the tools left out; a mission worked out (Can /
  Asks first / Cannot); connecting an account in its three shapes (a pasted
  key, a client the gateway registers, a broker's client with its provider,
  scopes and the two ways to get one); retired permissions, tools, health and
  links. The page is HTML built from the data, with the gateway's display codes
  mirrored in the site's CSS, light and dark; the Markdown twin keeps the same
  order, the map as a list by undo row. The page never says "tier": the undo
  rows' words are `UNDO_ROW_WORDS` of `@vaubaan/policy-engine`.

### Changed

- **vaubaan.com reads everything a plugin page needs from the plugin and the
  policy engine** (website spec §2.3, ADR plugin-contract-and-credential-spec,
  amendment 2026-11-05). Per permission: the six facts, the undo word, the
  tier, the per-minute ceiling, the patterns, `replaced_by`, one variant per
  environment; per macro-action: its narrative and each entry written out at
  the three trust levels (gate or left out, quota, rate); per plugin: icon,
  colour, resource noun, the tools left out, the worked mission (first two
  macro-actions at Careful), and the declared examples run through `classify`
  at build — slices, permissions touched, the gate Careful gives each. The
  build fails, naming the plugin, the tool and the sample, when a sample lands
  only on the fallback or `classify` refuses it. Also: "Anything else" and the
  retired permissions, the counts of the opening, what each tool usually
  touches, the worked mission as Can / Asks first / Cannot. The credential says
  its client source (`pasted-key` with its guide and the tools each permission
  serves, `gateway-registered`, `broker` with provider and scopes); the connect
  page no longer describes a brokered way as a client the gateway registers.
  The words of the risk model (the six facts and their values, the gate words,
  Can / Asks first / Cannot, the trust levels), `tierFactsOf` and
  `macroActionsOf` move into `@vaubaan/policy-engine`: the gateway re-exports
  them, the site imports them, nothing is copied.
  `/plugins.json` carries all of it; the plugin page's Markdown prints the
  narratives.

## [2.0.0-alpha.17] - 2026-11-05

### Added

- **Asana plugin** (`@vaubaan/plugin-asana` 0.1.0): one resource per project, its sections, tasks,
  subtasks and comments, personal access token; macro-actions `read`, `work` and `clean-up`; a
  task is proven to belong to the mission's project before every task call.
- **Axonaut plugin** (`@vaubaan/plugin-axonaut` 0.1.0): the CRM, pipeline, quotations, invoices, payments, projects, tasks, tickets and products of one Axonaut account, with the API key of one Axonaut user; macro-actions `read`, `crm`, `sell` and `clean-up`; creating an invoice and deleting a record are irreversible and always ask first.
- **Outlook plugin** (`@vaubaan/plugin-outlook` 0.1.0): mail and calendar of a
  Microsoft 365 or Outlook.com account over Microsoft Graph, with a token from
  the OAuth broker's `microsoft` provider; one resource, the mailbox; reads
  zoned by sender, drafts and sends by recipient, invitations by attendee;
  macro-actions `read`, `draft`, `send`, `tidy`, `schedule` and `invite`.
- **The OAuth broker serves Microsoft** (`@vaubaan/oauth-broker` 0.5.0): the
  `microsoft` provider (identity platform v2.0, `common` tenant: work, school
  and personal accounts) with the delegated Graph permissions `User.Read`,
  `Mail.ReadWrite`, `Mail.Send` and `Calendars.ReadWrite`. Microsoft has no
  endpoint that revokes one refresh token, so `/revoke` for it answers 204
  without calling Microsoft (logged `reason: no_revoke_endpoint`). The account
  is read from the ID token's `email`, or its `preferred_username` when that is
  one address.
- **Plugins bundled with the image or pinned by the operator** (ADR
  plugins-bundled-or-pinned-by-the-operator): a plugin directory under
  `plugins.dir` (`/plugins` in the image) replaces the bundled plugin of the
  same id, logged at boot; `plugins.enabled` lists the plugins an instance
  registers. The boot stops (exit 78) on a pin built for another SDK range, a
  pin `definePlugin` refuses, two pins of one id, an unknown id in
  `plugins.enabled`, or a provider the store holds accounts for that no
  registered plugin serves. The release workflow publishes every bundled
  plugin as `ghcr.io/vaubaan/plugin-<id>:<version>` (a `plugin-<id>-v<version>`
  tag publishes one alone). The instance reads the published versions feed at
  start and daily (`updates.check`, on by default; `updates.feed_url`), a GET
  that carries nothing about it, and keeps what is behind and what an
  advisory names for Administration; nothing is downloaded.
  **Administration › Plugins** lists every plugin the instance knows (version,
  bundled or pinned and what a pin replaces, enabled or not, accounts served,
  community validation) under what the feed reports: the gateway or a plugin
  behind its release, an advisory naming a loaded version with the version that
  fixes it, a pin older than the bundled version; "Check now" re-reads the feed.
  The **Reference** names each plugin's version and tags a pinned one.
  `reseal` loads the plugins as the boot does, pins included.
- **Website: `/versions.json`**, the versions feed instances read, built at
  build time from `releases.json` and `advisories.json` (a malformed file fails
  the build), cacheable for an hour; the trust center and the telemetry docs
  name it among what leaves an instance.

- **The site answers `/.well-known/microsoft-identity-association.json`** from the request-time
  variable `MICROSOFT_IDENTITY_APP_IDS`: Microsoft's check that vaubaan.com is the publisher domain of
  the OAuth broker's Entra application. 404 when the variable is unset.

### Changed

- **The OAuth provider table is shared by the gateway and the broker**
  (`@vaubaan/oauth-broker` 0.4.0, ADR
  oauth-brokers-managed-in-settings-with-two-client-sources): endpoints,
  allowed scopes and consent parameters move to `packages/oauth-providers`;
  the broker runs a byte-identical copy in its own sources (still no
  dependency, no build step; a test fails when they differ), its content
  unchanged. The gateway reads the table and refuses to boot when a brokered
  plugin names a provider it does not list or a scope that provider does not
  allow; a structural test holds every shipped brokered plugin to it.

### Plugin SDK

- **0.6.0 — errors carry a brand, the SDK says its version.** Every error class
  the host inspects (`UpstreamAuthError`, `CredentialRefusal`,
  `UpstreamHttpError`, `UpstreamProtocolError`, `ExecutorRefusal`,
  `GitProtocolError`, `PktLineError`) sets a
  `Symbol.for('@vaubaan/plugin-sdk/<ClassName>')` brand, read by the new guards
  `isUpstreamAuthError`, `isCredentialRefusal`, `isUpstreamHttpError`,
  `isUpstreamProtocolError`, `isExecutorRefusal`, `isGitProtocolError`,
  `isPktLineError`; `SDK_VERSION` is the SDK's version. A minor, not a patch:
  the host recognises errors by brand only, so a pinned plugin built against
  0.5 (no brand) would have its errors misread; its range `^0.5.x` keeps it
  out.

### Documentation

- Facts a first visitor reads, made true again: Node.js 26 and npm 11 on the website's quick look and coding-agent install (and an `.nvmrc`); the upgrade page takes the new release image by tag or digest instead of waiting for a release; the deploy quick start clones into `gateway`; the deploy guides connect accounts on Accounts → Connect an account instead of the removed Company apps page; the site footer, trust center and README no longer say no version is published; the supported versions name the release candidates; customer names removed from test fixtures and script examples.

## [2.0.0-alpha.16] - 2026-11-04

### Added

- **Notifications reach messaging addresses and mail** (spec §4.2 bis), wave 2:
  in Settings → **Notifications** a person adds the incoming webhook of a
  Slack, Microsoft Teams (Workflows), Discord or ntfy channel, or any https URL
  that takes a JSON body, and switches mail to their own address on or off when
  the instance delivers mail. An address is kept only after a test message got
  a 2xx (the page says the status otherwise, never the URL), sealed under the
  master key, never shown back, at most 10 per person; each notification is
  posted to every address and recorded as delivered or failed, never retried.
  Slack, Teams and Discord must be on the vendor's hosts; ntfy and "Other"
  refuse `localhost`, private and reserved addresses, at add and before each
  send. A channel receives the notification's title, body and link only.
  Administration → People shows how many channels a person has. Migrations
  `0031_notification_addresses` (sealed, resealed by `reseal`) and
  `0032_notification_mail`. Audit acts `address-added`, `address-removed`,
  `mail-notifications-changed`. Outbound hosts in handbook configuration.
- **A resource set is one environment, with optional future resources** (ADR
  resource-set-is-one-environment-with-optional-future-resources): a set is an
  explicit list whose resources all carry one environment, plus `future`: a resource
  that later appears there (discovered, or relabelled into it) is written into the
  list, and one relabelled out of it leaves it, each audited on the mission
  (`mission-resource-joined`, `mission-resource-left`). What a mission reaches is its
  lists only, never the connection resolved at call time. Discovery runs every hour
  for the connections a future set depends on, and on demand from a mission card
  (`POST /api/missions/<id>/resources/check`); the mission detail says when each
  account was last checked. Drafts gain `future` and `env`; `{ scope: 'all' }`,
  `{ scope: 'connection' }` (now `all` + `future`) and a selection given on the
  connection are split into one set per environment. New issues
  `resource-set-mixed-env`, `resource-unlabelled` (an unlabelled resource enters a
  set only where no permission depends on the environment); notices
  `split-by-environment`, `unlabelled-resources-left-out` replace
  `later-resources-need-env-label`. Migration `0033_resource_set_future_and_env`
  writes whole-connection sets out as their lists with future on; a set spanning
  environments keeps working until its next edit splits it.

- **The OAuth broker caps refreshes per instance** (`@vaubaan/oauth-broker`
  0.3.0): each enrolled instance may call `/token` `refresh_per_hour` times an
  hour (600 unless set in `OAUTH_BROKER_CONFIG`, refilled evenly), so one
  instance cannot spend the quota of the client every instance shares. Past it
  the broker answers 429 `rate_limited` with `retry-after` before calling the
  provider; a gateway reads it as a broker failure and retries, never as an
  expired connection.

### Changed

- **Base image Node 26.13.0** (`node:26.13.0-bookworm-slim`, multi-architecture digest), for the
  gateway and the OAuth broker's Dockerfile.
- **The mission screen is cards** (spec §4.2): creating and editing show only the
  mission's cards — one account and the resources of one environment each.
  "+ Add an account" picks the account, then its resources grouped by
  environment, plus "+ future <resources>". Each macro-action is set Careful,
  Trusting, Autonomous or **Custom** (its permissions one by one in a modal,
  filterable by plane, "never in <env>" where the catalog refuses); the (i) of a
  row shows the same content read-only. A sticky bar says what changed. The
  mission page is that screen frozen, with today's use per macro-action (the
  permission closest to its limit, "Raise this limit") and "↻ Check now" on cards
  with future resources; stop, duplicate and replace key are in "···". The
  missions list hides stopped missions behind a Running / Stopped filter.
  Removed: the Simple/Advanced views, "Everything I hold" and "Select all" in the
  form, the rail, the mission page's permission table and its "ask me first"
  switch, "Change limits" and the stop zone.

- The management door's mission views carry `resource_selections` (`future` and
  `env` per set) instead of `resource_scopes`; the `resource-not-in-mission` hint
  field is `takes_future_resources`.

### Plugin SDK

- **0.5.1 — a plugin names its resources.** `ProviderPlugin.resourceNoun?:
{ one, other }` (new type `ResourceNoun`) says what one resource of the
  provider is called in the interface (`board` / `boards`); `definePlugin`
  checks both forms are lowercase nouns of at most 40 characters
  (`RESOURCE_NOUN_MAX_LENGTH`). Every shipped plugin declares one; the gateway
  says `resource` / `resources` for a plugin without one.

### Documentation

- **Running one's own OAuth broker**: `deploy/README.md` and the site's new
  page Operations → Your own OAuth broker walk a self-hoster through the
  broker Google Calendar needs (own Google client, `unattested`, enrolment,
  `oauth_brokers.<name>.*`). A provider page of a brokered plugin no longer
  says the gateway registers its own client there.

## [2.0.0-alpha.15] - 2026-11-02

### Added

- **Notifications on your devices** (spec §4.2 bis; ADR
  notifications-reach-the-persons-own-channels), wave 1: the interface is
  installable from the browser (`/manifest.webmanifest`, a service worker
  `/sw.js` that shows notifications and caches nothing), and Settings →
  **Notifications** subscribes this device, lists, renames and removes a
  person's devices. A device is told when a request opens in its person's
  inbox (claim, approval request, permission request), when an account of
  theirs needs reconnecting, when a mission of theirs is orphaned or revoked by
  someone else, and an administrator's when a scheduled backup fails or the
  master key names an administrator. A notification names the mission or
  account and the tool, never an argument, and leads to the page where the
  person answers. The home proposes it once when something waits ("Not now"
  remembered by the browser); Administration → People shows how many devices
  each person has. Web Push (RFC 8291 / RFC 8292) is built on `node:crypto` and
  `jose`, with a VAPID key pair the instance generates and seals: nothing to
  configure. Migration `0030_notification_devices` (subscriptions sealed under
  the master key, resealed by `reseal`). Outbound: the push services of the
  browser vendors, over 443 (handbook configuration). CSP gains
  `worker-src 'self'` and `manifest-src 'self'`. Audit acts `device-added`,
  `device-removed`.

- **GitHub: `github__add_labels` puts labels on an issue or a pull request**
  (1 to 20 names, each at most 50 characters, trimmed; a label the repository
  lacks is created) and answers the names the issue now carries. New risk
  `github.label-write`, one slice per label (`issue[N].label[<name>].W`) so a
  mission can be narrowed to named labels, in the macro-action `propose`
  (catalog version 12). Token permission: Issues (read and write), already
  asked. An agent can now put the `e2e` label that runs a pull request's
  browser tests.

- **Vercel: `vercel__disconnect_git` removes the Git repository link of a
  project** (`@vaubaan/plugin-vercel` 4.1.0, `DELETE /v9/projects/{id}/link`
  under the connection's team): pushes no longer trigger deployments. It is
  priced like the other build-pipeline writes, `vercel.project-settings-write`
  (macro-action `own`); no new risk. It answers `{ ok: true, projectId }`:
  Vercel's project object (environment values, deploy-hook URLs) is dropped.

### Security

- **Vercel: the `vercel__update_project_settings` answer no longer carries
  environment variable values nor deploy-hook URLs** (`@vaubaan/plugin-vercel`
  4.1.0). Vercel answers the PATCH with the whole project; it now goes through
  the project redaction of `get_project` (allow-list: the settings fields,
  `framework`, `buildCommand`, `rootDirectory`, `nodeVersion`…, come back as
  they are). The risk `vercel.project-settings-write` is `data: metadata`.

### Changed

- **Google Calendar calls Google's Calendar REST API v3** (plugin 0.4.0; ADR
  google-calendar-through-an-oauth-broker, rewritten 2026-11-02). Google's
  hosted Calendar MCP server is open to Google Workspace Developer Preview
  members only, and Google refused the application: plugin 0.3.0 could not
  work for us nor for any customer outside the Preview. The nine tools keep
  their names and are now the plugin's own, each on the REST API
  (`calendarList`, `events.list / get / insert / patch / delete`,
  `freeBusy.query`): no Developer Preview membership and no "AI-powered
  agent" client flag are needed any more. `sendUpdates` (`all`,
  `externalOnly`, `none`) replaces the MCP's `notificationLevel`; time ranges
  are `timeMin` / `timeMax`, text search `q`, paging `maxResults` /
  `pageToken`; `search_events` now honours `calendarId` (it searched the
  primary calendar only); `suggest_time` computes free slots from the
  free/busy of the account and the people named; `create_event` /
  `update_event` take `addGoogleMeet`. The deprecated `eventTypeFilter`,
  `attendeeEmails` (of `create_event`) and `addedAttendeeEmails` are gone.
  Same two scopes, same risks, same macro-actions (catalog version 4: the
  wording of `notify-guests` names `sendUpdates`).

### Upgrade notes

1. **Google Calendar connections keep working**: the sealed refresh token,
   the broker and the two scopes are unchanged, and an access token for them
   is valid on the REST API. The broker's Google Cloud project needs the
   Calendar API enabled (it already did); an account whose discovery failed
   under 0.3.0 for want of the Developer Preview only needs its calendars
   refreshed. Agents that sent `notificationLevel`, `startTime` / `endTime`
   to `list_events` or `query` to `search_events` are refused with the
   argument named, and use the new names.

## [2.0.0-alpha.14] - 2026-11-02

_Tagged on 2026-11-02 and never published: the release gate failed on browser tests whose GitHub
permission count was written by hand (#184 fixed the tests). Nothing was pushed to GHCR and no
GitHub release exists for this tag; its content is released as 2.0.0-alpha.15._

## [2.0.0-alpha.13] - 2026-11-02

### Upgrade notes

1. **The git remote's path names the provider.** It is now
   `<public_url>/git/<provider>/<owner>/<repo>.git` (`/git/github/acme/app.git`),
   and the kit's rewrite maps `https://github.com/` to `<public_url>/git/github/`.
   Agents configured from a kit taken before this version must take their
   mission's kit again (or replace `/git/` with `/git/github/` in their remotes
   and `insteadOf` rule): the old path answers `404` with the remotes the
   instance serves.

### Changed

- **A git remote per provider, any number of them** (ADR
  protocol-doors-belong-to-the-host). The git door resolves the plugin from
  the `<provider>` segment of its path and serves it only if it declares
  `gitRemote`; an unknown provider, or one without a git remote, is answered
  `404` before the key is read, and a mission without a connection on that
  provider is refused and audited by the resource stage. The registry no
  longer refuses a second plugin declaring `gitRemote`. The catalog's
  `git_remote`, the kit (one `insteadOf` rule per provider), the mission page
  and the Reference give the new URLs.
- **Telemetry: a stable, framed instance identifier replaces the daily one.**
  The instance profile (level `usage-stats` only) carries `instance_id`, 128
  random bits the gateway draws once and keeps in its store, instead of a
  `day_id` drawn again every UTC day. It is never sent with a call report or a
  decision. Settings → Administration → Telemetry shows it and has a
  **Regenerate identifier** button (audited as `config-changed` on
  `instance-config:telemetry-instance-id`). A restore from a backup keeps it.
  The collector still accepts `day_id` from earlier gateways.
- **Telemetry: the community success rate leaves out rejected credentials.**
  `plugin_stats` gains `credential_rejections`; `success_rate` is
  `successes / (reports - credential_rejections)`, null when nothing is left,
  and `validated` uses it. The badge shows no rate for a null one.
- **Collector**: new public view and endpoint `GET /v1/plugin_instances`
  (distinct gateways per plugin, version and minor over 90 days); `day_id`
  renamed `instance_id` in `deploy/collector/schema.sql` (apply it before
  deploying the site). Rows stored before 2026-11-02 over-count gateways until
  the window rolls past them.
- **vaubaan.com plugin pages show the figures of every version.** The plugin
  pages, their Markdown twins, `plugins.json` and `llms-full.txt` read the
  collector when a page is served, refreshed at most hourly. `/plugins` lists
  `Plugin | Version | Gateways | Calls | Success` with two rows per plugin (the
  minor of this release, then the latest other minor known; the Permissions
  column is gone); each plugin page says how many gateways run it and lists its
  last ten versions with `Validated`; `/plugins/health` explains the figures.
  Nothing is hidden below the report threshold any more: `validated` is a mark,
  not a gate. `plugins.json` gains `health_refreshed_every_seconds`,
  `health_read` and `health_footnote`; per plugin, `health` is `gateways`,
  `minors[]` and `versions[]`.

### Plugin SDK

- **0.5.0 — any number of plugins declare `gitRemote`.** `PluginRegistry`
  loses `gitRemote()` (the single plugin declaring one) and gains
  `gitRemoteOf(id)` (the plugin `id` names, if it declares a git remote) and
  `gitRemotes()` (all of them); the registry no longer refuses two plugins
  declaring `gitRemote`. `GitRemoteCapability` is unchanged:
  `repositoryOf(path)` still receives the path after the provider segment,
  `.git` removed.

## [2.0.0-alpha.12] - 2026-11-01

### Upgrade notes (from 2.0.0-alpha.11)

Read these before starting the new image on a running instance:

1. **Sign-in provider `idp`.** Its callback is now
   `<public_url>/auth/callback/idp`: add it at the identity provider (beside
   `/auth/callback`, which nothing serves any more) **before** upgrading, or
   nobody signs in through it. Settings saved in Administration under the old
   single-provider keys are moved to the provider `idp` at the first start; the
   variables `VAUBAAN_IDP_*` / the `idp:` block stop the boot (exit 78) and are
   written `VAUBAAN_SIGN_IN_IDP_KIND=oidc`, `VAUBAAN_SIGN_IN_IDP_ISSUER`,
   `…_CLIENT_ID`, `…_CLIENT_SECRET`, `…_CLAIM_*`, `…_ALLOWED_EMAIL_DOMAINS`,
   `…_INVITATION_ONLY` (`sign_in.idp.*`). An admin group whose name holds a
   colon is written `idp:<group>`.
2. **A source of client addresses.** The image refuses to start without
   `VAUBAAN_TRUSTED_PROXIES` or `VAUBAAN_CLIENT_IP_HEADER`, unless
   `VAUBAAN_ACCEPT_SHARED_ADDRESS_WINDOWS=1`. The reference compose file now
   trusts Caddy's fixed address `172.30.253.2` on a network of its own
   (`172.30.253.0/29`): if your `.env` sets `VAUBAAN_TRUSTED_PROXIES=172.16.0.0/12`,
   remove it. Railway: set `VAUBAAN_CLIENT_IP_HEADER=x-real-ip` once verified
   (`deploy/railway.md`), `VAUBAAN_ACCEPT_SHARED_ADDRESS_WINDOWS=1` until then.
3. **The master key leaves the data volume (Compose).** `compose.yaml` mounts
   a new `gateway-key` volume at `/keys` and the example `.env` names
   `/keys/master.key`. An instance whose `.env` still names `/data/master.key`
   keeps starting, with a boot warning: copy the key there, name it in `.env`,
   then remove the old copy (`deploy/README.md`, "Upgrading an instance whose
   key is on the data volume").
4. **Mission tokens issued before 2.0.0-alpha.1 and never used since** are
   revoked by migration 0028 (they were still stored as argon2id) and must be
   re-issued: rotate the member's key, or replace the named key. Tokens used
   once since then are not affected.
5. **Accounts created before 2.0.0-alpha.1 that nobody signed in to since**
   (stored without an issuer) are no longer bound at their next sign-in: the
   person gets a new account; the boot log counts such accounts.

### Security

- **A deadline on every plugin call** (`execution.call_timeout_seconds`,
  `VAUBAAN_EXECUTION_CALL_TIMEOUT_SECONDS`, default 120). The plugin receives a
  signal that fires when the caller leaves or the deadline passes, and the
  gateway stops waiting at the deadline even for a plugin that ignores it: a
  provider that never answers no longer pins the request, the decrypted
  credential and the audit entry. Such a call is audited `upstream_error … (timeout)`,
  stays counted, and the agent reads `Upstream error: timeout: …`. Discovery,
  refresh and the git sweeper carry their own bounds; no plugin call runs
  without a signal.
- **The master key apart from the store by default.** The reference compose
  file keeps the generated key on a volume of its own; the boot warns when the
  key file and the store share a mount, unless
  `encryption.accept_key_beside_store` (`VAUBAAN_ACCEPT_KEY_BESIDE_STORE=1`).
- **No shared address windows in production by accident.** With
  `NODE_ENV=production` the boot refuses a configuration with neither
  `trusted_proxies` nor `client_ip_header` unless
  `accept_shared_address_windows`; the request page keys its window on the
  signed-in user, so an anonymous flood never holds a creator out of an
  approval link; the compose file no longer trusts the whole Docker pool.
- **Wrong bootstrap tokens in setup mode survive a restart**: counted in
  `setup-misses` beside the key file, removed once the setup completes.
- **A token, a share and held arguments are reached with their parent only**:
  the repositories take `(missionId, tokenId)`, `(connectionId, shareId)` and
  `(missionId, requestId)`; a bare-id lookup does not compile.
- **The argon2id token path is gone** (the `argon2` native addon stays, for
  local-account passwords):
  migration 0028 revokes the tokens still stored that way.

### Added

- **Resource sets: one account of a mission split in parts with their own
  rights and budget** (risk model §4.7). In the mission form, an account with
  two resources or more offers "+ Add a resource set": each set picks its
  resources (or takes every resource no other set picks, or the whole account)
  and has its own trust levels and lines. A call naming a resource is judged,
  gated and counted by that resource's set; a call naming none, or resources of
  several sets, must be allowed in each of them, waits for the strictest gate
  and is charged in each. What a call creates joins the set it was judged
  against (judged against several: the whole-account set if any, else the
  first of them). The management door, the preview, an edit, a share's duplicate, the
  bootstrap kit and the mission page accept or show `resource_sets`; a draft
  without them is one set, as before. Migration 0029 gives every existing
  mission one set per account: nothing changes for it.
- **Trust-raise proposals** (risk model §4.7). After 10 approvals granted on
  one macro-action of one resource set, with no refusal since its trust level
  last changed, the mission page and Now offer the creator to raise it by one
  level. "Raise" opens Edit mission at the new level, naming the lines edited
  by hand it replaces; "Not now" hides the offer until as many approvals again.
  Nothing is raised automatically, and Autonomous is never offered. The
  threshold is `trust_raise.after_approvals`
  (`VAUBAAN_TRUST_RAISE_AFTER_APPROVALS`, default 10).
- **Contributors sign off their commits** (Developer Certificate of Origin,
  no CLA): `git commit -s`, explained in `CONTRIBUTING.md`; the CI job
  `audit` refuses a pull request with an unsigned commit
  (`scripts/dco-check.mjs`).
- **Governance and plans are written down**: `MAINTAINERS.md` (who
  maintains, how decisions are taken, how a maintainer is added, how the code
  is written with coding agents), `ROADMAP.md`, `.github/CODEOWNERS`, a
  first-contribution section and the label list in `CONTRIBUTING.md`, a
  `NOTICE` file, and `docs/architecture.md`, the path of a request in ten
  minutes.
- **Ceilings and counters** (spec §4.3 bis). `limits.users`,
  `limits.connections` and `limits.active_missions` (`VAUBAAN_LIMITS_*`, each a
  whole number >= 1, absent unlimited) cap what the instance holds: only an
  addition is refused at the ceiling — a first sign-in, an invitation, a
  reactivation; a new connected account (never a reconnection); an issuance,
  a duplicate, a v4 import, or a new end for an ended mission — with the count
  and the ceiling in the refusal (`instance-limit-reached` on the management
  door). Nothing existing is cut. Settings → "This gateway" shows each count
  against its ceiling. `GET /ops/stats`, opened by the bearer `ops.token`
  (`VAUBAAN_OPS_TOKEN`, at least 32 characters; absent: 404), answers counts
  only: users, connections by provider, active missions, the day's calls, the
  store's size, the sealed values per key version, the ceilings.
- **New mission and Edit mission compose a policy from macro-actions at a
  trust level** (ADR macro-actions-and-trust-levels-prefill-the-policy, risk
  model §4.6). Per account, the Simple view lists the service's
  macro-actions, "Anything else" included; each ticked at Careful, Trusting
  or Autonomous says what it writes here (runs freely, asks first, left out,
  not available to you) and the account says its highest tier. The
  Advanced view is the permission-by-permission editor; "Everything I hold
  on this account" stays. The mission still stores the explicit list; the
  trust levels are kept (migration 0025, `mission_connections.crans_json`) only to
  redraw the form, which opens in the Advanced view when the lines differ
  from what the trust levels write. A draft may carry `trust_levels` per connection;
  unknown macro-actions are dropped. The preset chips are gone from the form.
- **Agents compose missions from macro-actions too; presets are retired.**
  On the management door a draft connection gives `trust_levels` (macro-action →
  trust level) and the preview writes its policy, reporting what the trust levels leave
  out in `left_out` (outside the authority, no resource in the environment,
  or a tier the trust level does not accept). `list_my_connections` says what
  each macro-action yields at each trust level (`at_trust_level`) and `get_catalog` gives
  each risk's tier and macro-action, the macro-actions with their base
  budgets and the trust level table. "Give access" ticks a macro-action's
  permissions in one click; the Reference compares every permission across
  the three trust levels. A risk whose tool hands the agent a token that can write
  asks first at every trust level. The v4 import writes each kept risk at
  Trusting; "Everything I hold" takes its budgets from the macro-actions at
  Autonomous.
- **Gmail sends mail over SMTP** (`@vaubaan/plugin-gmail` 1.1.0, ADR
  gmail-over-imap-with-an-app-password amended). Two tools: `send_message`
  (a plain-text message) and `send_draft` (an existing draft as it is, by
  its id, refused unsent unless its To, Cc and Bcc are the ones the call
  declares; it leaves Drafts once sent). They go to `smtp.gmail.com:465`
  with the app password the connection already holds, through `nodemailer`;
  Bcc travels in the envelope only, and Gmail files the copy in Sent. Four
  new risks price a send by its worst recipient: to the mailbox itself, to
  internal recipients, to allowlisted contacts, to anyone else (irreversible,
  personal data, public). They form the new "Send" macro-action:
  an existing mission gains no send until its creator accepts one. A refused send opens no connection. Gmail catalog version 8.

- **The OAuth broker runs without an enclave** (`@vaubaan/oauth-broker` 0.2.0,
  ADR oauth-broker-can-run-without-an-enclave). The published image with
  `OAUTH_BROKER_PLATFORM=unattested` opens one plain HTTP listener for the
  API, the callback and `/healthz`, behind the platform's TLS. Its secrets
  come from `OAUTH_BROKER_SECRET_GOOGLE_CLIENT_SECRET` and
  `OAUTH_BROKER_SECRET_REFRESH_TOKEN_SEALING_KEY`, each removed from
  `process.env` once read. `/attest` answers 404 `not_attested`. Tokens are
  still sealed to their instance and the configuration still holds digests
  only. Gateways reach such a broker only when declared `attestation: none`,
  at a URL such as `https://broker.example.com` (port 443 implied), and say
  "not attested". Whoever operates the platform can read both secrets and run other code in
  the image's place. In
  Confidential Space nothing changes: the launch policy still fixes the
  platform.

### Changed

- **The provider `idp` is an ordinary sign-in provider.** The single-provider
  keys (`idp.*`, `VAUBAAN_IDP_*`), the settings form that saved them and the
  `/auth/callback` route are gone; stored settings move to `sign_in.idp` at boot
  (upgrade note 1). Administration audit entries of its settings say
  `sign-in:idp`.
- **The connect page keeps the plugin's sentence of a rejection** ("Gmail
  refused the IMAP sign-in of x: the app password is wrong…"), masked of every
  value of the pasted credential, instead of "the provider rejected the
  credential (HTTP 401)"; refreshes, later discoveries and logs keep the status
  alone.
- **The account page names the permissions a token lacks**, when the service
  says what the token holds (`CredentialCheck.granted`).
- **Configuration**: `execution.call_timeout_seconds`,
  `encryption.accept_key_beside_store`, `accept_shared_address_windows` are new;
  the `idp.*` keys are refused.
- **Code a visitor reads first**: the test fakes moved from `src/server` to
  `apps/gateway/tests/support`; the pure rules a form runs from `src/server` to
  `src/lib`; one form reader (`http/form.ts`) and one client `postJson` /
  `useAction`; the barrels of `@vaubaan/shared`, `@vaubaan/gateway-core` and
  `@vaubaan/policy-engine` name their exports; property tests cover the slice
  matcher, the argument fingerprint, the audit reason and the trust-level
  budget.

- **The trust levels speak English** (owner decision of 2026-10-31, ADR
  macro-actions-and-trust-levels-prefill-the-policy, renamed from
  `macro-actions-and-trust-crans-prefill-the-policy`). The trust level a
  creator picks for a macro-action is Careful, Trusting or Autonomous, and
  the tier of a risk (1 mild to 4 irreversible) decides what each writes;
  what each level writes is unchanged. Breaking for agents using the
  management door: `crans` is now `trust_levels`, values
  `careful|trusting|autonomous` (were `prudent|confiant|autonome`);
  `list_my_connections` says `at_trust_level` (was `at_cran`), `get_catalog`
  gives each risk's `tier` (was `palier`) and the `trust_levels` table, and a
  line a trust level leaves out has `reason: 'trust-level'`; a draft asks
  for everything the user holds with `everything_i_hold: true` (was
  `preset: 'everything-i-hold'`, and `unknown-preset` is gone). The
  decision core's entry point is `evaluateCallForMission` (was
  `evaluateCallForToken`), without the v4 explicit deny. Migration 0027
  renames `mission_connections.crans_json` to `trust_levels_json` and
  rewrites the stored values to the new names, so a running instance keeps
  every mission's recorded levels on upgrade; agents holding a draft with
  `crans` must send `trust_levels`.

- **Google Calendar asks two scopes instead of four**
  (`@vaubaan/plugin-google-calendar` 0.3.0): `calendar.calendarlist.readonly`
  and `calendar.events`, which Google's reference accepts for every read tool
  and `suggest_time`; `calendar.events.readonly` and
  `calendar.events.freebusy` are no longer asked, and the broker's allowlist
  (`@vaubaan/oauth-broker` 0.2.2) no longer admits them: a gateway on an older
  plugin must upgrade, and a connection made before is reconnected.
- **The README opens for a visitor**: a short pitch, badges, two screenshots
  of the demo, `npm run demo` first, "How it works" in a few lines, and a
  Status that says what to expect from a pre-release. The handbook
  `cutover-from-v4` is now `first-install`. `npm run test` passes in a source
  tarball, without `.git`.
- **The documents say what the repository does.** `SECURITY.md` names the
  supported line (the latest `2.0.0-alpha` pre-release, cut from `main`) and
  when each scanner runs; `README.md` and `CONTRIBUTING.md` target `main` and
  Node 26; the deploy README, the example configuration and the collector
  README say that the built-in collector URL is the project's live collector,
  which an enabled instance sends to, and what each telemetry level carries;
  the Supabase and Railway plugin READMEs describe the pasted token their
  code declares instead of a retired OAuth app; the website's status copy
  names the published pre-releases; the pull-request and issue templates ask
  for macro-actions, not presets, and offer the three credential kinds that
  exist. Test fixtures name an imaginary company.
- **Plugin SDK 0.2.0: the token guide is structured, and says how wide to
  grant** (ADR one-place-to-authorize-services-token-first, amended
  2026-10-31). Breaking for plugin authors: `TokenGuide.steps` are
  `GuideStep { do, url?, code? }` instead of strings; a guide declares
  `reach { what, grant, why }` and `expiry` (`provider-reports`,
  `person-types` with `recommendedDays`, or `none` with a `reason`) in place
  of `recommendedExpiryDays`; `docsUrl` is required. `CredentialCheck` may
  carry `granted`, the permissions the provider confirmed. An `api-key`
  way without `label`, `createUrl`, `guide` or `verify` is refused by
  `definePlugin`: the guide is part of the plugin contract, the template
  (`@vaubaan/plugin-template` 0.1.4) ships a complete one and
  `plugins/README.md` step 5 says what each part holds. The test kit gains
  `guideText` and `apiKeyCredentialFixture`. The GitHub, Supabase, Notion, CalDAV, Fly, Context7,
  Railway and Gmail guides move to the new shape (`@vaubaan/plugin-github`
  4.0.5, `-supabase` 5.0.5, `-notion` 0.1.5, `-caldav` 0.1.3, `-fly` 0.3.4,
  `-context7` 0.1.5, `-railway` 5.1.4, `-gmail` 1.1.1).
- **The connect page shows the whole guide, open.** How wide to grant and
  why sits above the steps; a step links its page and shows its command as
  code to copy; the service's documentation is linked; the expiry is worded
  by who knows it (the service reports it and the account page warns, the
  person picks it and the gateway cannot read it back, or the token does not
  expire and how to end it); "Tick all of them" for the permissions. The
  how-to of a sign-in or a key pair is open by default.
- **The guided services ask for fewer visits.** Notion asks to share the
  pages before the paste, so the first discovery finds them; CalDAV has one
  step per server (iCloud, Fastmail, Nextcloud) with its page and the server
  URL to copy; Fly links its dashboard's Tokens page and offers the
  `fly tokens create org` command to copy, with no caveat file to write;
  Gmail checks IMAP before the paste; every step is an action, the notes
  moved into how wide to grant. Supabase and Fly say the expiry is chosen
  at the service and not read back. A structural test holds every shipped
  token way to the complete guide.
- **Cloudflare DNS, Stripe, Vercel, Upstash Redis and Resend guide the
  connection and check the token at paste** (`@vaubaan/plugin-cloudflare-dns`
  3.0.5, `-stripe` 0.4.5, `-vercel` 3.0.5, `-upstash-redis` 3.2.4, `-resend`
  0.5.4). Each connect page now has the exact token page, numbered steps,
  how wide to grant and why, the permissions mapped to the tools they unlock
  (Cloudflare's four permission rows, Upstash Read/Write, Resend Full access)
  and the expiry; "Check and connect" asks the service first: Cloudflare
  reads the token's status and expiry and names the accounts of its zones,
  Stripe names the account each secret key opens, Vercel checks the token
  opens the team and reads its expiry, Upstash checks the key, Resend names
  the account by its domains. A Cloudflare token without zones, a Stripe
  restricted key that cannot read its account, a Vercel token that cannot
  open the team and a Resend Sending access key are refused with what to
  change. Stripe asks for the secret key instead of a restricted one.
- **Every risk catalog groups its risks into macro-actions** (ADR
  macro-actions-and-trust-levels-prefill-the-policy), 3 to 5 per connector in
  its own words (Gmail: Search the mail, Draft, Tidy; GitHub: Read, Propose,
  Ship, Administer…), each risk listed once with a base budget. A catalog
  without them, or with a live risk in none or in two, no longer loads. The
  policy engine gains the trust levels (Careful, Trusting, Autonomous) that turn
  a macro-action into explicit lines: the gate follows the risk's tier, read
  from its vector, and the budget is multiplied ×1, ×3 or ×10. Every shipped
  plugin gains a patch version and a `catalog_version`.
- **The OAuth broker logs why a redeem was refused** (`@vaubaan/oauth-broker`
  0.2.1). The gateway still gets one `invalid_grant`; the access log line of
  `/grants/redeem` now carries a fixed `reason`: `grant_unknown`,
  `consent_incomplete`, `flow_mismatch`, `provider_not_served`,
  `provider_refused`, `provider_unavailable` or `no_refresh_token`. Never
  provider text.
- **Plugins call their provider through the SDK's transport.** The template
  (`@vaubaan/plugin-template` 0.2.0) uses `httpJson`, `refusalResult` and
  `jsonResult`; a workspace list it cannot read is a provider failure
  (`UpstreamProtocolError`), no longer a plain error. Miro
  (`@vaubaan/plugin-miro` 0.5.0) drops its own JSON-RPC client for the SDK's:
  a JSON-RPC error frame, or a refused board search, is now recorded as the
  provider's failure (HTTP 502) instead of a fault of the plugin. GitHub
  (`@vaubaan/plugin-github` 4.0.6) imports the git wire code from
  `@vaubaan/plugin-sdk/git`. A plugin, its tests included, may import nothing
  of the gateway but the SDK (lint rule).
- **Every provider plugin calls its provider through the SDK, declares its
  names once and takes its identifiers from the SDK** (audit of the plugin
  SDK, findings M2, M4, M5, M6, M9). No plugin reads a response with
  `.json()` / `.text()` or casts an answer to a `…Dto` type: answers go
  through `httpJson`, `readBounded` and type guards, the rewrapped MCP
  servers through the SDK's client, and an answer the plugin cannot read —
  not JSON, a JSON-RPC error frame, a shape the guard refuses — is the
  provider's failure (`UpstreamProtocolError`, HTTP 502), no longer a plain
  error filed as a fault of the plugin. Executors decline only with
  `refusalResult` / `ExecutorRefusal`. Every plugin has a `src/identity.ts`
  (provider id, tool names) and no other file writes them; `ANY_IDENT`
  comes from the SDK. GitHub writes an identifier the slice grammar cannot
  carry as "any" instead of repairing it, declares its global search as an entity, and
  its job slices and Vercel's deployment and environment-variable slices go
  through their declared parents; no catalog changes. New versions:
  `@vaubaan/plugin-github` 5.0.0, `-supabase` 6.0.0, `-railway` 6.0.0,
  `-vercel` 4.0.0, `-cloudflare-dns` 4.0.0, `-upstash-redis` 4.0.0, `-gmail`
  2.0.0 (a refusal no longer carries `structuredContent`), `-ssh` 2.0.5
  (`command-classes.ts` split into `src/command/`), `-stripe` 0.5.0 (an
  undeclared argument is declined by the executor too), `-resend` 0.6.0,
  `-fly` 0.4.0, `-notion` 0.2.0, `-context7` 0.2.0, `-google-calendar`
  0.2.0. Structural tests hold the rules: `plugin-transport`,
  `plugin-names-declared-once`, `plugin-identifier-helpers`,
  `plugin-versions` (a plugin README states no version any more) and
  `plugin-data-model-paths` (no known gap left).

- **The image carries `LICENSE` and `NOTICE`** at `/app`, as a redistribution
  under Apache-2.0 should.

### Removed

- **Catalog presets.** No plugin ships `presets`, a catalog with the key no
  longer loads, and the plugin SDK loses `presetsOf`, `assertPresetsValid`
  and the `Preset` types (`policyFromMacroActions` in `@vaubaan/plugin-sdk/testing`
  writes a test policy from macro-actions instead). A draft's `preset` takes
  only `everything-i-hold`; any other id is `unknown-preset`. The management
  door's `presets` fields are replaced by `macro_actions`, `trust_levels` and
  `everything_i_hold`, and the preview's `skipped_from_preset` by `left_out`.
  Every plugin gains a patch version and a `catalog_version`; Gmail's comes
  with its 1.1.0.

### Security

Fixes from the pre-publication security audit of 2026-10-31.

- **The second factor is locked after ten wrong codes**, for fifteen
  minutes, counted per person in the store (migration 0026); a sign-in then
  answers `second-factor-locked`. The step that asks for the code lasts ten
  minutes from the password, wrong codes included: retrying no longer
  extends it.
- **Password hashing no longer blocks the gateway.** Local-account
  passwords are hashed by the native `argon2` binding on the thread pool
  instead of libsodium's synchronous build, with the same limits and format:
  stored passwords verify unchanged, and an earlier image still verifies a
  password set by this one. The instance-wide window of the password forms
  goes from 300 to 60 posts a minute, and a locked account is refused
  before any hash.
- **"Forgot password" answers before the reset link is made and mailed**,
  so its time no longer tells whether an address has an account.
- **Testing a sign-in provider is a form**, origin-checked like every
  mutation (`POST /auth/test/<id>`); a link can no longer start a test.
- **Provider plugins refuse redirects** (`redirect: 'error'` on every call),
  so a custom credential header (Supabase's `apikey`) cannot follow one to
  another origin; a Semgrep rule holds it for new plugins. Patch releases:
  `@vaubaan/plugin-cloudflare-dns` 3.0.5, `-context7` 0.1.5, `-fly` 0.3.4,
  `-github` 4.0.5, `-notion` 0.1.5, `-railway` 5.1.4, `-resend` 0.5.4,
  `-stripe` 0.4.5, `-supabase` 5.0.5, `-upstash-redis` 3.2.4, `-vercel`
  3.0.5.
- **CalDAV sends the app password to the typed server and to the calendar
  home's host announced at discovery only** (`@vaubaan/plugin-caldav`
  0.2.0), not to any sibling host a later
  answer names.
- **The reference deployment is hardened**: the Compose gateway runs on a
  read-only root filesystem with no capability and no new privilege (`/tmp`
  a tmpfs), Caddy compresses static assets only (no compression oracle on
  pages that show a token), the image installs and builds as an
  unprivileged user, and the entrypoint never follows a link on `/data`.
- **A release is never published un-audited**: the dependency audit fails a
  release run when the registry cannot answer (a merge still only warns).
- Mission-token symbols are drawn without modulo bias; the attested OAuth
  broker's key pinning is held by a structural test and a Semgrep rule;
  every CI checkout keeps no token.

### Plugin SDK

`@vaubaan/plugin-sdk` is versioned on its own, by the rule of the
[plugin SDK handbook](docs/handbook/plugin-sdk.md) (Versions): below `1.0.0` a
minor version may break a plugin, and every breaking change is listed here.
The package is now publishable (`dist/` with declarations, three entry points)
but not published.

- **0.4.0 — no tool hands a token, and the test kit speaks English.**
  `tokenHandouts`, `TokenHandout` and `writeHandoutRiskIds` are gone (owner
  decision of 2026-10-31, spec §2.4): a plugin that still declares
  `tokenHandouts` does not load (`RETIRED_TOKEN_HANDOUTS_ISSUE`). No shipped
  plugin declared one. The policy engine's `TrustLevelCandidate` loses
  `hands_write_token`, the Reference loses its "hands a token" marks and the
  mission page its raw-token warning. `@vaubaan/plugin-sdk/testing` renames
  `MacroActionCranChoice` to `MacroActionTrustLevelChoice` and `palierOf` to
  `tierOf`; trust levels are `careful|trusting|autonomous`.

- **0.3.1** — `httpJson` takes `rawBody` (a form, a multipart `FormData`,
  bytes) instead of a JSON `body`, never both: Stripe, Cloudflare's zone
  import and Supabase Storage send it.
- **0.3.0** — the contract slimmed, one way to call a provider (ADR
  plugin-contract-and-credential-spec, amendment of 2026-10-31). Breaking:
  - `ProviderPlugin.normalizeForCaps` and `ProviderPlugin.normalizeArgs` are
    removed, with `flags.ts` (`PluginHostFlags`, `DEFAULT_HOST_FLAGS`,
    `normalizeArgsIfEnabled`): no host called them.
  - The git wire code and `GitRemoteCapability` with its types leave the main
    entry for `@vaubaan/plugin-sdk/git`.
  - No longer exported from the main entry: `ScopeCaps`,
    `CREDENTIAL_SENTENCE_MAX_LENGTH`, `structuralIssues`, `isCompleteVector`.
  - Added: `httpJson`, `upstreamFailure`, `readBounded`, `readBoundedText`,
    `readPrefixText`, `readShape`, `anyJson`, `UpstreamProtocolError` (502),
    `UpstreamAnswerTooLarge`, the upstream MCP client (`mcpRequest`,
    `callUpstreamTool`, `firstJsonRpcFrame`, `upstreamToolResult`),
    `textResult`, `jsonResult`, `isRecord`, `isList`, `slicePathIssue`,
    `catalogPathIssues`; in `/testing`, `assertSlicesOnDataModel`,
    `decideCall` and the policy-engine functions plugin tests use
    (`risksTouchedBy`, `evaluateCall`, `envResolverFor`, `indexCatalog`,
    `qualifyRiskId`, `tierOf`, `matches`…).
- **0.2.0** — the token guide is structured (entry under Changed). Breaking:
  `TokenGuide.steps` are `GuideStep { do, url?, code? }`;
  `recommendedExpiryDays` is replaced by `expiry`; `reach` and `docsUrl` are
  required; an `api-key` way without `label`, `createUrl`, `guide` or `verify`
  is refused by `definePlugin`. Since 0.1.0 also: catalog presets are retired
  (`presetsOf`, `assertPresetsValid`, the `Preset` types removed; a catalog
  with `presets` does not load).

## [2.0.0-alpha.11] - 2026-10-29

### Added

- **The OAuth broker** (`apps/oauth-broker`, `@vaubaan/oauth-broker` 0.1.0):
  the open-source broker of ADR oauth-broker-stateless-in-an-attested-enclave.
  It keeps no token: the instance receives the refresh token at the redeem,
  **sealed to that instance** (AES-256-GCM, opened only for the instance's own
  broker key), and the broker opens it and adds the client secret only when
  that instance refreshes or revokes. Flows live ten minutes in memory, at most
  500 per instance; the instance and the PKCE verifier are checked before the
  provider's code is exchanged, and every flow starts with a PKCE verifier of
  the broker's own. Its gateway API speaks TLS with a key generated in the
  enclave; `POST /attest` — no key, no body, rate-limited — answers a cached
  attestation bound to that key. The configuration holds digests only (it is
  readable from the attestation). Google Confidential Space adapter
  (attestation token from the launcher; client secret and sealing key through
  Workload Identity Federation and Secret Manager) and a development adapter.
  No dependency outside Node; provider endpoints compiled in. The image is
  reproducible and signed keylessly with cosign by a workflow that runs on
  `oauth-broker-v*` tags only, and pushes nothing before two builds from
  scratch agree. Spec `docs/spec/oauth-broker.md` (draft), handbook
  `docs/handbook/oauth-broker.md`.
- `oauth_brokers.<name>.attestation` (`VAUBAAN_OAUTH_BROKER_<NAME>_ATTESTATION`):
  `required` (the default) or `none`, for your own broker outside an enclave;
  the connect page and the account page then say the broker is not attested.
  It never widens the allowlist. An attested broker is reached over https
  only.

### Changed

- **The OAuth broker keeps no token, and the gateway verifies it before it
  sends anything** (ADR oauth-broker-stateless-in-an-attested-enclave). The
  contract of 2.0.0-alpha.10 changes: the redeem answers the provider's
  refresh token, which the instance seals with the connection; the refresh is
  `POST /token {provider, refresh_token}` and the revocation
  `POST /revoke {provider, refresh_token}`; an `invalid_grant` on a refresh
  makes the connection expired; errors are `{error, message}`. Every call
  goes over a TLS connection whose key an attestation of the broker carries
  (`POST /attest`, with no body and without the broker key, which goes only
  over a pinned, verified connection): a Google Confidential Space token the
  broker caches and refreshes every five minutes, checked against Google's
  keys, at most ten minutes old, debug off, a stable image on a confidential
  VM (AMD SEV, SEV-ES or Intel TDX), bound to the connection's TLS key, and an
  image digest on the allowlist shipped with the release
  (`broker-measurements.json`). The broker's URL is a root URL with a port;
  the broker runs as a single replica (one pinned key). The refresh token is
  opaque to the gateway. This release admits OAuth broker
  0.1.0 on Google Confidential Space (image digest
  `sha256:40d4ebfc018ce1dd283e4e820de084747f66a2d734129ca0e43305bb95a7d980`);
  a broker reporting any other measurement gets nothing, and connecting says
  "no attested broker version admitted by this release". No broker was
  ever enrolled, so no connection or configuration needs migrating.
- **Service marks are drawn in their brand colour.** The icon of a service
  (Accounts, the connect picker, the mission form, Reference) is drawn in the
  colour its plugin declares (`ProviderPlugin.iconColor`, Simple Icons' hex
  for the brand) on the same neutral square; a near-black brand (GitHub,
  Notion, Vercel, Railway, Resend, Miro, Fly.io) takes the ink in the dark
  theme. Every shipped plugin declares its colour; the released ones gain a
  patch version.
  ADR service-marks-in-brand-colour, amending
  service-icons-declared-by-the-plugin.

- **The image carries `LICENSE` and `NOTICE`** at `/app`, as a redistribution
  under Apache-2.0 should.

### Removed

- The mission page's **Modify permissions** button and its page. Adding or
  removing a permission by hand is **Edit mission**, which has done the same,
  with the rest of the mission, since alpha.8; the narrower editor remains the
  screen that answers an agent's permission request.

## [2.0.0-alpha.10] - 2026-10-27

### Added

- **CalDAV Calendar plugin** (`@vaubaan/plugin-caldav` 0.1.0): calendars on
  any CalDAV server — iCloud, Fastmail, Nextcloud and the others that speak
  the standard — connected with a server URL, a username and an app password.
  Each calendar is a resource; six tools list calendars and events, read an
  event, and create, change and delete one, as JSON fields (the plugin writes
  the iCalendar itself). Writes are priced by who the server may notify:
  attendees inside the company domains, on the allowlist, or outside; a
  change or a deletion is checked against the server's copy before anything
  is written, and every write is conditional on the etag the agent read.
  Presets `read-only`, `own-agenda` and `assistant`. Google Calendar is not
  reachable this way (Google refuses app passwords over CalDAV): it is the
  `google-calendar` plugin. ADR google-calendar-through-an-oauth-broker, D5.
- **Google Calendar.** A new plugin, `google-calendar` (0.1.0), relays Google's
  official Calendar MCP server: list the calendars, list, search and read
  events, suggest a time, create, change and delete events, answer
  invitations — one resource per calendar. Inviting people of the company and
  people outside it are separate permissions (each calendar's internal
  domains decide), and so are letting Google email the guests of a change,
  and deleting. Presets `read-only` and `assistant`. The scopes are the
  narrowest that cover the tools, never the full calendar scope. ADR
  google-calendar-through-an-oauth-broker.
- **OAuth brokers.** An instance can be enrolled with an OAuth broker
  (`oauth_brokers.<name>.url` and `.key`, the key a secret like every other;
  `.providers` optional): a service that owns the OAuth client at a provider
  offering no key and no dynamic registration, runs the sign-in and keeps the
  refresh tokens. The instance keeps a grant id and a short-lived access
  token; the provider's data never goes through the broker. A plugin whose
  broker is not configured is listed as not configured, with the reason; a
  broker that is down shows as the broker's failure, never as an expiry. The
  contract a broker implements is the handbook page oauth-broker-contract,
  with a fake broker in the test kit.
- **SDK.** An `oauth2` spec names exactly one client source:
  `clientRegistration` or `broker: { provider }` (`OAuth2BrokeredSpec`,
  `isBrokeredSpec`, `PluginRegistry.brokerProviders()`).

## [2.0.0-alpha.9] - 2026-10-27

### Changed

- **Gmail is no longer experimental, and no plugin can be.** A mission that
  accepts Gmail permissions now lists Gmail's tools to the agent's MCP client
  (they were left out before, so the agent saw none). Gmail accounts appear
  on the mission form, in the reference and in the management door's
  `list_my_connections` like any other; the "Show experimental services"
  toggle and the "experimental" tags are gone. The Gmail plugin
  (`@vaubaan/plugin-gmail` 1.0.0, catalog 6) only drops the word from its
  descriptions. For plugin authors: `experimental` is removed from
  `definePlugin` and from `labels()`. For MCP clients: `list_my_connections`
  no longer answers `hidden_experimental`, and still accepts, and ignores,
  `include_experimental`. The public site's plugin pages and `/plugins.json`
  drop the `status` field. ADR no-experimental-plugins.
- **Dependencies.** better-sqlite3 13 for operators: the store's SQLite driver
  is now an N-API addon whose binaries ship in the package, so the image build
  no longer downloads one for the Node version, and SQLite moves from 3.53.2 to
  3.53.4. The database file, its WAL and the backups are unchanged; nothing to
  do on upgrade.
  For contributors: Vitest 5 (same projects `shared` and `isolated`, same
  commands, same tests) and TypeScript 6.0 (no configuration change).
  TypeScript 7 waits for typescript-eslint to support it (ADR typescript-7).

## [2.0.0-alpha.8] - 2026-10-26

### Added

- **A sign-in provider says when it was set up for another address.** After a
  restore on a new host, the sign-in page tells, under "Continue with
  <provider>", that the provider was set up for the former address and signs
  people in here once an administrator has registered this one at the
  provider (and to use the email and password meanwhile, with local
  accounts); Settings → Sign-in shows the callback to register and the setup
  checklist names the provider. A provider's state records the address at
  its save and at every passed test. ADR
  backup-carries-the-sign-in-configuration, amendment 2026-10-23.
- **Gmail's tools run, over IMAP.** The Gmail plugin (0.5.0, still
  experimental) exposes twelve tools: search threads with Gmail's own
  syntax, read a thread, download an attachment, list and create drafts,
  list and create labels, add and remove labels. Drafts are saved, never
  sent: the plugin reaches Gmail over IMAP and ships no SMTP client. Thread
  and message ids are the Gmail API's (hexadecimal).
  - A message without a plain-text part is read from its HTML, converted to
    text with its links kept (`html-to-text`); the text is capped at 20 000
    characters.
  - Each message lists its attachments; `gmail__get_attachment` returns one
    in base64, up to 5 MiB, and refuses a larger one.
  - A user label is addressed by its name, spaces and accents included
    (`Factures payées`, `Projets/Été`).
  - `gmail__create_label` creates a user label, under the new risk
    `gmail.label-create`, which is in the `developer` preset (catalog 5).

  ADR gmail-over-imap-with-an-app-password and its amendment.

- **What a mission creates, it reaches.** A mission that creates a resource
  through the gateway (`miro__board_create`, `fly__create_app`,
  `railway__create-project`, `resend__create_domain` / `create_segment`,
  `upstash_redis__create_database`) reaches it right after the call, whatever
  its resource scope: before the answer leaves, the plugin reads the new
  resource from the call's answer (new optional SDK hook `createdResources`,
  required with `resourceCreatingTools`), the gateway records it on the
  account and adds it to the mission's selection. The mission page marks it
  "created by this mission", the mission's activity says it "reached a
  resource it created", and the audit records `mission-resources-added`
  (cause `created-by-the-mission`). A resource first seen less than 15 minutes
  ago is no longer marked stale by a discovery that does not list it yet (Miro
  lists a new board minutes late). Migration `0024` (`mission_resources.source`,
  `connection_resources.first_seen_at`). Plugins: Fly 0.3.0, Miro 0.4.0,
  Railway 5.1.0, Resend 0.5.0, Upstash Redis 3.2.0. ADR
  created-resources-join-the-mission.

- **A mission is edited after issuance by its creator, same key.** "Edit
  mission" on the mission page opens the creation screen prefilled with the
  mission: its name, end date, accounts, resources (a board created after
  issuance can now be added), permissions with their limits, rate window and
  "ask me first" all change in one edit; the period does not (duplicate the
  mission for another one). Saving lists every change before → after with what
  it means — a limit already used up, a permission removed and the requests it
  closes, a resource no longer reached. The edit is judged by the creation's
  own check on what moves only, applies at once to the same token, session and
  counters, closes the claims and approval requests about a removed
  permission, and leaves one `mission-changed` entry in the activity with each
  section before and after. A connected app cannot edit a mission. API:
  `POST /api/missions/:id/edit` and `…/edit/preview`. ADR
  mission-editable-after-issuance, superseding
  mission-limits-editable-after-issuance.

### Changed

- **Runtime: Node 26.** The image is built on `node:26.12.1-bookworm-slim`
  (pinned by digest, as before), CI and the release run Node 26, and
  `engines` asks for Node 26 and npm 11; `@types/node` follows (26.x).
  The native addons (`better-sqlite3`, `argon2`, `ssh2`'s `cpu-features`)
  load from their prebuilt binaries for the new ABI. An operator who runs
  the published image has nothing to do: pull the new tag and restart, the
  store and the configuration are unchanged. Running from source needs Node 26. ADR docker-image-and-config-format, amendment 2026-10-26.
- **Gmail connects with an app password.** A person creates an app password
  named "Vaubaan Gateway" in the Google Account of the mailbox (2-Step
  Verification on) and pastes it with the address; the gateway signs in over
  IMAP before storing it. No Google Cloud project, consent screen or
  redirect URI any more: the `redirect_uri_mismatch` of the OAuth way is
  gone with it. **A Gmail account connected by OAuth runs nothing until its
  owner reconnects it** with an app password (same account, resources and
  shares); its page and its discovery say so.

- **The `resource-not-in-mission` hint and the "Every resource known now"
  choice say both ways a resource joins a mission.** The hint of a mission
  with an explicit list, the setup kit, the issuance form's "Every resource
  known now", the management door's instructions and Miro's refusal of an
  unknown board say that a resource the mission creates through the gateway
  is reached at once, and that any other one is added to the same mission by
  its creator with "Edit mission" (same key), instead of a new mission being
  needed.

- **Dependencies.** Next.js 16.4.2, js-yaml 5 (the risk catalogs are read
  with the same safe schema: JavaScript, local and binary tags and complex
  keys are refused), imapflow 2.5.6 for Gmail; ESLint 10 for contributors.

- **The image carries `LICENSE` and `NOTICE`** at `/app`, as a redistribution
  under Apache-2.0 should.

### Removed

- **OAuth clients declared by an administrator.** Gmail was their only user:
  the OAuth client form of a connect page, the setup checklist's "OAuth
  clients" step, the management door's `setup.company_apps`, the route
  `POST /admin/provider-apps/<provider>`, the stored `provider_apps.*`
  settings (deleted by a migration), and the configuration keys
  `providers.<id>.*` / `VAUBAAN_PROVIDER_<ID>_<FIELD>`, which are no longer
  read: an instance that still sets them starts and logs a warning naming
  each one. In the plugin SDK, `appConfigFields`, `ProviderAppConfig`,
  `ConnectionContext.appConfig`, `CLIENT_ID_FIELD` and `CLIENT_SECRET_FIELD`
  are removed, and an `oauth2` spec must declare `clientRegistration` (the
  gateway registers its own client, as for Miro).

### Security

- **nodemailer 10.1.7** (from 10.1.0): three address-parser advisories of
  2026-10 (GHSA-85x2-q946-cp5h, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w),
  which the dependency audit gate reported.

## [2.0.0-alpha.7] - 2026-10-23

### Changed

- **The project's telemetry collector is published, and the placeholder gate
  is gone.** `https://telemetry.vaubaan.com/v1/reports` now answers, and an
  instance whose administrator turns telemetry on sends its reports there
  (or to `telemetry.collector_url` when set) instead of reading "On, but
  nothing is sent". Telemetry stays off by default; while it is off nothing is
  sent and no statistics are read. The client has two gates, disabled and
  sending: the `placeholder-collector` state, `isPlaceholderCollector` and the
  `placeholderUrl` option of `@vaubaan/telemetry` are removed. ADR
  telemetry-collector-shape, amendment of 2026-10-23.

## [2.0.0-alpha.6] - 2026-10-23

### Changed

- **The interface takes a shadcn-near-default skin and a path bar.** Slate
  neutrals, a sky accent, 13 px text, 36 px rows, in both themes; the values
  of the tokens change, not their names. Above every page, a bar says where it
  is — this gateway, the section, the page's crumbs and title — and holds the
  theme toggle and the person, which leave the side navigation. The local
  navigation of Settings and of the Reference is a row of tabs under the bar,
  not a column. ADR shadcn-near-default-skin-and-path-bar.

- **The accounts without owner are the last region of Accounts**, for an
  administrator, shown only when at least one account needs an owner. Settings
  loses the "Accounts without owner" entry; `/admin/connections` redirects to
  `/accounts#without-owner`, and the setup checklist still leads there when it
  matters. ADR ownerless-accounts-live-on-the-accounts-page.
- **The setup checklist no longer asks for a service nobody uses.** While no
  OAuth client is declared, the "OAuth clients" step is absent instead of
  reading "Gmail is not: nobody can connect…" for good; once one is declared,
  the step lists it, done. The connect page of the service keeps saying what
  it needs. ADR setup-checklist-lists-only-what-is-needed.
- **Connected apps says how an app connects.** The page's one action, "Connect
  an app", leads to a region with the management door's address, the Claude
  Code command and what follows (sign-in, consent); Registered apps says that
  apps register themselves and nothing is created there.
- **A service is shown by its brand icon, monochrome.** Accounts, the connect
  picker, Reference and an account's page mark a service with the icon its
  plugin declares (`ProviderPlugin.icon`, the path of one SVG on a 24-unit
  grid, filled with the secondary ink on a neutral fill — never coloured),
  in place of two letters on a hue. Every shipped plugin declares one
  (twelve from Simple Icons, CC0 1.0; Context7 and SSH drawn by hand) and
  takes a patch version; a plugin without an icon still shows its two letters.
  The hues now mean a person. ADR service-icons-declared-by-the-plugin.

## [2.0.0-alpha.5] - 2026-10-23

### Changed

- **The audit stores the accepted-risk snapshot once per distinct set and the
  remaining budget of the touched risks only — about 98% fewer audit rows per
  call.** A call entry still carries the mission's accepted risks at call time,
  but entries under the same accepted risks share one stored copy, and its
  per-risk rows are the risks the call touched. On a mission holding about 100
  risks a call wrote about 17 KB of audit rows; it now writes a couple of hundred
  bytes. Entries written by an earlier version are not rewritten (the audit is
  immutable): they read as before and leave with the retention. Schema
  migration 0022. ADR audit-risk-snapshot-stored-once.
- **The scheduled backup is compressed before it is encrypted.** Backups are
  now written in format `vaubaan-backup` v2: the store copy goes through
  Brotli (quality 4, from Node's own `zlib`), then is encrypted exactly as
  before (AES-256-GCM in 1 MiB chunks, a key derived from the master key, here
  with its own HKDF label). On a store made mostly of activity rows the object
  is about four times smaller (22.9 MB → 5.4 MB in 0.3 s). The header declares
  the store's size: the restore refuses one above `restore.max_mb` before
  decompressing anything, and stops a file that decompresses past its declared
  size. `restore` (the command and the first boot) reads both v1 and v2
  backups; a v2 backup does not restore on 2.0.0-alpha.4 or earlier. The
  backup report gains the store's size beside the object's (Settings →
  Encryption, `store_bytes` in the `/healthz` `backup` object); the
  `x-amz-meta-sha256` of the object is still the hash of the uploaded bytes.
  ADR scheduled-encrypted-backup-to-object-storage, amendment 2026-10-23.
- **Activity loads earlier lines as you scroll.** The record showed 50 lines
  and hid the rest behind a small "Earlier" link. Reaching the end of the list
  now appends the next 50 to the same table, with the filters kept, up to
  1,000 lines per address; a "Load earlier" button does the same without
  JavaScript or from the keyboard, and the end of the record says "No earlier
  activity". The detail of a line loaded later opens without losing the lines
  already loaded, and `?cursor=` links still open the record at a position.

## [2.0.0-alpha.4] - 2026-10-23

### Added

- **Scheduled, encrypted backup to S3-compatible storage.** Set the
  `backup.s3.*` keys (endpoint, region, bucket, prefix, path-style, access key)
  and the gateway backs itself up on its own schedule (`backup.every`, 1h to
  24h, from `backup.at`, UTC), keeping the `backup.keep` newest. Each backup is
  the `backup` command's copy, encrypted under a key derived from the master
  key (AES-256-GCM in chunks, HKDF; the file names the key versions it needs),
  restored into a temporary file and checked — integrity, schema, every sealed
  secret opened — before it is uploaded; one that fails is not uploaded and the
  failure is recorded. Settings → Encryption shows the latest backup and the
  latest failure, `GET /healthz` gains a `backup` object (no endpoint, bucket or
  credential) for an external checker, and the activity records each run. The
  `restore` command and the first-boot restore take these backups as they take
  a plain copy, with the SHA-256 of the object. Not yet tried against a real
  bucket. ADR scheduled-encrypted-backup-to-object-storage.

### Changed

- **Disconnecting an account takes that account only out of its missions.**
  A mission that uses several accounts keeps running on the others, with its
  keys, its limits and what it counted; calls through the disconnected account
  are refused with a new code, `connection-revoked`, whose hint says it never
  comes back, to keep using the other accounts, and to ask the mission's
  creator for a mission on the account that replaced it (git through the
  gateway reads the same). Its tools leave `tools/list`; the catalog marks it
  `lost`. Removing someone's access to one account does the same, until an
  access is given again. A mission whose every account is gone, a mission
  whose creator was deactivated, and one under an access narrowed to less
  than it uses still stop as a whole. The mission page says which account no
  longer serves and whether it comes back ("Lost an account" in the lists),
  `list_my_missions` carries `lost_connections`, and the audit records
  `mission-connection-lost` naming who disconnected. Nothing is ever added in
  a lost account's place. Before, one disconnected account stopped every
  mission that used it, whole and for good. ADR
  orphaned-missions-and-ownerless-connections, amendment 2026-10-21.
- The bootstrap kit's instructions list the new refusal code. The community
  collector's schema (`deploy/collector/schema.sql`) accepts it in a decision
  report: apply the file again on the collector, and deploy the website,
  before instances of this version report usage statistics.
- An account connected through the GitHub App of earlier builds
  (`app-install`) is reconnected with a token on the same account, its old
  credential never read — now covered by a test.
- **Miro connects through Miro's own MCP server, with one click and Miro's
  consent — no Miro app to create, nothing to paste.** The Miro plugin
  (0.2.0) rewraps Miro's official MCP server (`https://mcp.miro.com/`): the
  person signs in at Miro, chooses a team and allows the gateway, which
  registers its own OAuth client at Miro the first time someone connects. It
  works in a Miro Enterprise organisation that allows approved apps only, once
  its administrator has enabled Miro's MCP server. The tools are Miro's
  (canvas read and drawing as SVG, comments, images, prototypes, tables, a
  new board), each acting on a board of the mission; an update of what is
  drawn may delete, so it needs the deletion permissions and, in the
  facilitator preset, asks first. ADRs miro-rewraps-the-official-mcp-server,
  oauth-client-registered-by-the-gateway.
  **After the upgrade, Miro accounts connected with the access token of a
  Miro app run nothing until their owner reconnects them from Accounts** (the
  button now leads to Miro); their missions keep their permissions and
  presets, and their agents read the new tool list (the 30 tools of the REST
  plugin are gone).
- **The Miro tools follow Miro's real tool list** (plugin 0.3.0, catalog 3).
  The sign-in and Miro's tool list were verified against a real Miro account
  on 2026-10-23 (the tool calls themselves have not run live yet): the
  plugin's list is now Miro's, captured, and every tool takes Miro's own
  argument names (`canvas_search` searches by `patterns`, `table_create`
  takes `table_title`, `prototype_create` takes its screens as
  `html_contents`, `table_update_view` a `layout`…), with the optional ones
  Miro added. The fields in which Miro asks an agent to describe its own
  environment (`invocation_source`, `is_repository`) are never offered to
  agents nor sent. Six tools are added on a board of the mission: the space
  it is in, its title and description, who can open it, sharing it,
  changing someone's role on it, and a narrated walkthrough (boardcast). Each
  has a new permission; **sharing a board is its own permission, in the
  facilitator preset only, and asks first**; read-only and scribe never see
  who can open a board and never share one. Discovery now lists every board
  of the team, page by page (it would have stopped at 20, and read none from
  Miro's answer). Tools that hand out an upload address, and the space,
  section, blog-post, move and restore tools, stay out. ADR
  miro-rewraps-the-official-mcp-server, amendment 2026-10-23.
- **A service whose sign-in accepts dynamic client registration needs
  nothing from an administrator.** The gateway registers its own OAuth client
  there (named after the instance's host), keeps it sealed in the instance
  settings, reuses it, and registers again when the service rejects it or
  the public URL changed. Gmail still needs its client declared.
- **The connect page shows the reason a plugin gives for refusing a key**,
  in the plugin's own words ("the token is not limited to the organization
  'acme'…"), instead of a bare HTTP status; a provider's own text is still
  never shown. A refused OAuth sign-in now shows the protocol code only, never
  the service's description.

### Fixed

- **The second factor's codes copy in one click.** The recovery codes shown
  after an enrolment are one block with a copy button, and the secret's copy
  button gives it without the spaces it is shown with.
- **A Vercel token scoped to some projects connects.** Vercel refuses such a
  token every team-level read, and the connection used to fail on reading the
  team; it now lists the projects the token reaches. The `team_id` field is
  still the id of the team that owns them.

### Security

- **Fresher base images.** The image is built on `node:22.23.4-bookworm-slim`
  (was 22.23.3), whose Debian layer carries the seven `perl-base` fixes of
  `deb12u4`; their reviewed exceptions are gone from the image scan. The
  Caddy of `deploy/compose.yaml` stays 2.11.7, at its rebuilt digest.

## [2.0.0-alpha.3] - 2026-10-21

### Added

- **Google and Entra ID as presets of "Add a sign-in provider."** Beside OpenID
  Connect, GitHub and local accounts, two buttons fill the form in — Google's
  issuer, or the Entra tenant (its ID or domain, from which the gateway writes
  the issuer), the claim names, the admission rule that fits (a Workspace
  domain or invited people for Google, everyone of the tenant for Entra) — and
  spell out where to register the client, step by step, with the redirect
  address to paste. What is saved is an OpenID Connect provider, as before; a
  provider saved from a preset is edited with the same fields.
- **The backup carries the sign-in providers and the admin rule.** A copy made
  by the backup command now holds, beside the store, the sign-in providers set
  by the environment (client secrets sealed under the master key) and the admin
  rule, so a gateway restored on another host signs its people in as before.
  Restored, they are providers of the store, edited in Settings → Sign-in; the
  new host's environment adds its own and wins on a shared id. The identity
  provider must still accept the new host's callback address. ADR
  backup-carries-the-sign-in-configuration.
- **Recovery by the master key, loudly.** A gateway nobody can administer any
  more (a provider misconfigured, the last administrator's second factor lost,
  a restore on a new host) is recovered at `/admin/recover` by whoever holds
  its master key: the key file is read in the browser and never sent — the page
  proves holding it against a single-use challenge —, and the recovery names
  one administrator and nothing else. It is audited
  (`administrator-recovered`), mailed to the administrators when the gateway
  sends mail, and shown on every page for thirty days.

- **Test a sign-in provider beside your session.** "Test" opens the provider
  in another window, runs its sign-in to the end, and signs nobody in: the
  result page shows what the provider returned and the verdict a sign-in would
  get (administrator, user, or refused and why). During the setup, the tested
  identity can be made the first administrator from there.
- **Sign-in providers are switched on and off.** A provider added in
  Settings → Sign-in is off until a test passes, then switched on; the sign-in
  page offers only the providers that are on. Switching one off ends its
  people's sessions, never yours, and is refused when it is the last way in of
  every administrator. Providers saved before this version stay on.

### Changed

- **One way of connecting per service, a pasted token wherever the service
  offers one.** GitHub, Supabase and Railway connect with a token the person
  makes (for GitHub, a fine-grained token); Gmail keeps OAuth, its client
  declared by an administrator on Gmail's own connect page. **After the
  upgrade, an account connected through the GitHub App or a Supabase or Railway
  OAuth app runs nothing until it is reconnected with a token** — this includes
  the account the gateway's git remote pushes with. A push refused by GitHub
  with a 403 now says the token lacks write access to the repository. ADR
  one-place-to-authorize-services-token-first.

- **A second factor for everyone, whatever the sign-in provider.** Every
  sign-in now ends with the gateway's own code (an authenticator app, recovery
  codes shown once), enrolled at the person's first sign-in — through OpenID
  Connect and GitHub too, not only local accounts. **After the upgrade, every
  person is asked to enrol one at their next sign-in.** An administrator may
  waive it for a provider whose directory enforces its own (Settings →
  Sign-in): outright, or, for OpenID Connect, only when the provider's token
  says it asked one (`amr` contains `mfa`, as Entra ID and Okta send) — never
  for administrators. The factors local accounts already had move to their
  people at the first start. An administrator resets anyone's factor from
  People.

- **The setup ends by an explicit step.** "Finish setup" on the setup page
  revokes the install token, once the encryption key was handed over and an
  administrator can sign in. A sign-in no longer revokes it: an instance whose
  token is still active keeps showing the step until an administrator takes it.

- **The administrators live in the instance.** Who administers a gateway is
  kept in its store and changed from Administration → Users ("Make
  administrator", "No longer administrator", a group of a sign-in provider,
  pending addresses), audited. `admin.emails` and `admin.group` become
  optional: the first start of this version applies them once, while the store
  names nobody — **an instance upgraded from an earlier version keeps every
  administrator it had** — and a rule changed afterwards is shown, never
  applied by itself. Without a rule, the setup names the first administrator:
  the local account it creates may have any address. An act that would leave
  no administrator a way in (unmaking, deactivating, removing a provider) is
  refused, and removing a provider no longer signs its remover out. A start
  with no administrator, no rule and no bootstrap token is refused. ADR
  administrators-live-in-the-instance.

- **The image carries `LICENSE` and `NOTICE`** at `/app`, as a redistribution
  under Apache-2.0 should.

### Removed

- **Company apps.** The GitHub App, its manifest flow and installation
  verification, `github__mint_install_token` (its two risks deprecated in the
  GitHub catalog v9), the Supabase and Railway OAuth apps, and the Company apps
  page of Administration.

### Fixed

- **GitHub is refused as an OpenID Connect provider, with the way out.** GitHub
  speaks OAuth, not OpenID Connect: an OpenID Connect provider at
  `https://github.com` used to be saved, then fail every sign-in with "The
  identity provider could not be reached". The form in Settings → Sign-in, and
  `sign_in.<id>.kind: oidc` or `idp.issuer` at boot, now refuse any github.com
  address with "GitHub is not an OpenID Connect provider: choose the GitHub
  kind", and the form's help says so. The GitHub kind is unchanged.
- **The OpenID Connect form checks the issuer before saving.** A new issuer's
  discovery document (`<issuer>/.well-known/openid-configuration`) is fetched
  first; the provider is not saved when there is none, when it names another
  issuer, when it is not a discovery document, or when the gateway cannot reach
  it — and the form says which. The configuration file is not checked over the
  network at boot.

## [2.0.0-alpha.2] - 2026-10-19

### Added

- **"Everything I hold on this account"**, a preset the instance offers on every account
  next to the service's own, in the mission form and on the management door
  (`connections[].preset: "everything-i-hold"` of `preview_policy` / `issue_mission`). It
  writes out, at preview and at creation, every permission the creator may allow on that
  account that the selected resources can reach — an environment-qualified one only when
  a selected resource carries that label, deprecated ones left out, the uncategorized
  writes included — each with the service's rate ceiling, a daily limit from one
  documented rule (the largest a preset of the service gives it, else by severity) and
  "runs freely". The preview says how many permissions, the most severe, the critical
  ones and the uncategorized writes by name (notice `everything-i-hold-expanded`); the
  mission stores the explicit list, and a later change of what the creator holds does
  not widen it. `list_my_connections` lists it with `built_in: true`, and `get_catalog`
  with a `connection_id` writes it out. ADR `preset-everything-i-hold-expands-explicitly`.
- **A resource an agent creates through the gateway is known at once.** After a
  call that created an app on Fly (`fly__create_app`), a project on Railway
  (`railway__create-project`), a domain or a segment on Resend, or a database on
  Upstash Redis succeeds, the gateway looks for the account's resources again
  right after answering — the same merge as "Refresh" on the account page, so
  names, labels and hidden flags are kept and the account's default environment
  applies. A mission given the whole account reaches the new resource from its
  next call. The account page says when the last check followed such a call
  ("after a call of `fly__create_app`"), and Activity records it as "refreshed
  what an account reaches · after a call that created one". The agent is not
  kept waiting; a burst of creations makes at most two lookups. Plugins declare
  these tools in `resourceCreatingTools` (plugin SDK); Fly 0.2.0, Railway 4.3.0,
  Resend 0.4.0, Upstash Redis 3.1.0.
- **Local accounts: a sign-in provider that lives in the instance** (ADR
  `local-accounts-sign-in-provider`). A provider of kind `local`
  (`sign_in.<id>.kind: local`, or "Add local accounts" in Settings → Sign-in)
  keeps an email and a password per person — hashed with argon2id, twelve
  characters at least, ten wrong passwords in fifteen minutes locking the
  account for fifteen —, always "invited only": an invitation now also makes
  the single-use, fifteen-minute link through which the invited person creates
  their account, and People hands a password-reset link over the same way. A
  **second factor** (a code from an authenticator app, eight recovery codes
  shown once) is set up from Settings → Security, replaced or removed there,
  and **required for an address of `admin.emails`**: that person enrols it
  during their first sign-in. An administrator resets a person's second factor
  from People. The setup checklist creates the first administrator's account
  for an address of the admin rule; its first sign-in retires the bootstrap
  token. New configuration block **`mail.*`** (`VAUBAAN_MAIL_SMTP_HOST`,
  `_SMTP_PORT`, `_SMTP_USER`, `_SMTP_PASSWORD`, `_FROM`, `_TLS`): with a relay
  the invitation and reset links are mailed, and "Forgot your password?" on the
  sign-in page sends one; without it the links are handed over by an
  administrator. The telemetry profile counts the kind `local` with the
  others. Dependencies: `libsodium-wrappers-sumo` replaces
  `libsodium-wrappers` (same vendor and version; argon2id), `nodemailer`,
  `uqr`.
- **The setup link fills the bootstrap token.** Whoever installs a gateway can
  hand the operator `/admin/bootstrap#token=<token>`: the page reads the
  token from the fragment (never sent to the instance, so it reaches neither
  the access logs nor a referrer), fills the field and takes the token out of
  the address bar; nothing is submitted without the click. `?token=` is read
  too, for a link built the older way.

### Changed

- **A member of the admin rule's group is admitted at sign-in**, as an address
  of `admin.emails` is (ADR `sign-in-providers-admission-and-admin-rule`,
  amendment of 2026-10-19). An instance whose provider is "invited only" and
  whose admin rule moved from `admin.emails` to `admin.group` no longer locks
  its administrator out.

### Fixed

- **The generated master key on an empty volume.** With `VAUBAAN_MASTER_KEY_GENERATE=1`
  and a key file in a directory that does not exist yet (`VAUBAAN_MASTER_KEY_FILE=/data/keys/master.key`),
  the first start refused with `ENOENT` (exit 78). The generation now creates the missing
  parent directories (mode 0700; an existing directory is left as it is) and writes the
  key 0600 as before; a parent that is not a directory or cannot be created is still a
  configuration error naming the file (exit 78). The same holds for the key handed to the
  setup page to restore a copy on a new host.

- **The git remote accepts an annotated tag.** A push of `git tag -a` was
  rejected with "cannot be reviewed: it has no history in common with …": the
  review compared the tag object itself, which has no commit history. A tag is
  now reviewed through the commit it points at, annotated or lightweight, under
  the same `github.tag-write`; a tag of a commit no branch reaches is still
  refused with the same words, and a tag that names no commit is refused too.
- **The Settings icon is a gear.** It was a hub with eight rays, nearly the
  theme toggle's sun.

## [2.0.0-alpha.1] - 2026-10-18

The first release of the on-prem gateway. It replaces the earlier hosted product
(last release: tag `v4-final`) and shares no database with it: an instance starts
empty, and a one-shot importer carries an organization of the hosted product into
it (below). The notes below describe what the gateway does;
"Changed" and "Removed" are written for a reader who knew the hosted product.

**Words.** The interface speaks to people in its own words, and these notes use them
for what a person sees: an **account** (the protocol's _connection_), an **access**
(_share_), a **permission** (_risk_, by its `RiskId`), **limits** (_budget_: quota and
rate limit), **runs freely / ask me first** (_gate_ `auto` / `approval`), a **key** and
a **machine key** (_mission token_: member token, named token), **Replace key**
(_rotate_), **Waiting for you** (_requests_: an approval request, a claim), a
**connected app** (_delegation_), **Activity** (_audit_), a **teammate** and a **team**
(_mission member_, _group_), an **administrator** (_operator_), a **service** and its
**company app** (_provider_, _provider app_). MCP tool names, refusal codes, risk ids,
catalog files, API fields, database columns and configuration keys keep the protocol's
names, and the notes about them do too.

**Upgrade notes** — only for an instance that already runs a build made from the
`v5` branch:

- **Signed-in sessions now end after an hour without a request** (eight hours at most,
  as before). Nothing to configure; once, after the upgrade, everybody signed in more
  than an hour earlier signs in again. At start, the instance now logs an error when
  the configured master keys do not open what the store holds. A self resource (`VAUBAAN_SELF_RESOURCES`) whose
  provider is not a plugin id now stops the start (exit 78): check its spelling.
- **The `developer` preset of GitHub no longer hands out tokens; the gateway is
  the git remote.** Schema migration `0015` applies at start. Missions issued
  before keep their policy (it is stored, not derived from the preset), mint risks
  included. A new mission from `developer` holds `github.git-push` (runs freely)
  and `github.force-push` (asks first) instead of the two
  `mint-install-token-*` risks: point the agent's git at the instance with the
  setup kit's new step 4. If a reverse proxy in front of the instance caps request
  bodies or buffers them, lift it for `/git/` (a push body is the pack, up to
  `git.max_pack_mb`).
- **A sign-in provider anyone can hold an account at needs an admission rule.**
  Schema migration `0014` applies at start. If `idp.issuer` is
  `https://accounts.google.com` or a Microsoft multi-tenant or personal-accounts
  issuer and `idp.allowed_email_domains` is empty, the instance no longer starts:
  it admitted anyone with such an account. Set the domains, or
  `idp.invitation_only: true` and invite people on Settings → People. Everything
  else about `idp.*` is unchanged, its callback included (`/auth/callback`). An
  address of `admin.emails` outside the allowed domains is now admitted.
- **The gateway sets its own security headers.** If your reverse proxy adds
  `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy` or `Strict-Transport-Security`, remove
  them (the reference `deploy/caddy/Caddyfile` no longer sets any): a browser
  enforces two policies together.
- **`admin.group` names its provider once there are several.** With one provider
  the bare group name keeps working; to add a second provider, write it
  `<provider>:<group>` (`idp:gateway-admins` for the provider of `idp.*`).

- **Page addresses follow new words; old links keep working.** Accounts are under
  `/accounts`, what waits for you under `/waiting`, the activity record under
  `/activity`, the reference of each service under `/reference`, settings under
  `/settings`, and `/` is the home. What a colleague gave you access to is a region of
  `/accounts` (it was `/shares`), and connected apps are `/settings/connected-apps` (it
  was `/delegations`). Every earlier address answers with a permanent redirect, a form
  post included. **The callback registered at a service does not move**:
  `/connections/callback/<provider>` is still the URL of your GitHub App and of your
  OAuth apps; change nothing there. `/mcp`, `/mcp/manage`, `/r/<id>`, `/api/**`,
  `/oauth/**` and `/admin/**` are unchanged, and so are tool names, refusal codes, risk
  ids and configuration keys.
- **Sign in once before you change the identity provider.** Starting the new image
  applies schema migration `0011` (forward-only: an older image refuses to start
  on the migrated database). A user is now identified by the issuer of their
  sign-in and their subject, and the accounts that exist are bound, all at once, to
  the issuer of the first sign-in that follows the upgrade. Let one person sign in
  with the identity provider you use today; change `idp.*` afterwards if you must.
  Changing it in the same step binds every existing account to the new provider.
  There is no tool to move an account to another issuer.
- **Stray arguments are now refused.** The Cloudflare DNS, Vercel, Railway and
  Supabase plugins refuse a call that carries an argument its tool does not
  declare, naming the argument; they used to forward it or drop it. An agent that
  pads its calls with fields of the provider's own API (`target` on
  `vercel__deploy_to_vercel`, `project_id` beside `projectId`) must stop. The
  versions the plugins carry today are listed under "Added", below.
- **Railway: `deploymentId` and `threadId` are refused.** Neither can be tied to the
  mission's project, and the Railway credential reaches every project of the
  workspace, so the gateway no longer forwards them: `railway__get-logs` takes
  `serviceId` and `environmentId` and reads the latest deployment, and every
  `railway__railway-agent` call starts a new conversation. The tools no longer list
  the two arguments. The Railway plugin is `4.0.0`.
- **Railway: refresh the resources of each Railway account once.** A `serviceId` is
  checked against the services recorded for the mission's project at discovery; a
  project discovered by an earlier build has none recorded, and a call that names
  a service is refused until an owner presses "Refresh" on the account's page.
- **Disconnecting an account now withdraws the authorization at the service, where
  the service allows it.** Schema migration `0012` (forward-only, one nullable column).
  For Supabase (and the experimental Gmail plugin) the gateway asks the service to
  revoke the OAuth authorization and tells you whether it confirmed. For every other
  service it cannot, and says so before and after: the dialog and the page of the
  disconnected account tell you where to remove it by hand — uninstall the GitHub App,
  revoke the app in your Railway account, delete the API key for Vercel, Stripe,
  Cloudflare, Upstash and Resend, remove the public key for SSH. Accounts disconnected
  before this build asked nothing of the service: their page says to remove the
  authorization by hand.
- **Mission keys are stored as a SHA-256 digest; keys you already handed out keep
  working.** Nothing to do, and no schema migration. A key (a mission token) issued by
  an earlier
  build is stored as an argon2id hash: it still authenticates with the same Bearer,
  and its first successful call replaces the stored hash by the digest (one `info`
  log line, `mission token moved to its sha256 digest`). Until that first call, and
  only for such a token, wrong secrets replayed on its prefix are still throttled
  (429). **Do not go back to an older image after this one has served calls**: it
  reads argon2id only and would refuse every token that has been moved or issued
  since.
- **A connected app now ends 90 days after the consent.** An application you
  authorized (Settings → Connected apps) used to stay authorized for as long as it
  renewed its token. It is now refused 90 days after you consented, whatever it renewed,
  and sends you to the consent screen again; the missions it prepared are untouched.
  **Consents given more than 90 days ago stop at the first renewal after the upgrade.**
  The page shows the date for each. Administrators set another duration with
  `oauth.delegation_max_lifetime` (`VAUBAAN_OAUTH_DELEGATION_MAX_LIFETIME`).
- **One request per call that asks first.** A call that needs several permissions set
  to "ask me first" used to ask the creator once per permission, with a refused replay
  in between. It now drops one request that lists them all; approving it approves the
  call, and "Let it run freely until the reset" applies to each listed permission. The
  `approval-required` refusal carries `risk_ids` next to `risk_id`. Schema migration
  `0013` (forward-only). Requests that are open when you upgrade keep the one permission
  they named: approving one approves that permission, and a call that needs more gets a
  new request covering it.
- **`retention_days` also purges the session history.** The events of a mission's
  timeline older than the retention are deleted with the audit entries of the same age,
  and so are the counters of periods that ended longer ago. The counters of the current
  period, the gates opened in it and the credits granted in it are never purged. **The
  first start of this image deletes that history on an existing instance**: raise
  `retention_days` before you upgrade if you want to keep more than 90 days of it.
  The retention is 90 days unless `retention_days` says otherwise (instance
  configuration); a new instance starts empty, so nothing is deleted on its first day.
- **The plugin test kit proves "what is executed is what was classified" by running
  the plugin.** `assertIdentifiersRefused` feeds hostile identifiers to every string
  argument of a plugin's samples, through `classify` and through `execute`; every
  shipped plugin and the template run it, and a plugin whose tests do not is refused.
  A plugin author adds one test to `plugin.test.ts` (see `plugins/README.md`).
- **A preset never hands a write token without asking first.** A plugin now declares
  which of its token-handing risks are read-only (`TokenHandout.readOnlyRiskIds`); every
  other one is treated as write, and a plugin whose preset leaves a write one on `auto`
  is refused at load. GitHub is unchanged: the Developer preset still hands the clone
  token (read-only) freely and the push token after the creator's yes. Reference says
  "hands a read-only token" or "hands a write token".
- **Two accounts of one service in a mission: the refusal says why.** The rule is unchanged (one account per service); the message now names both accounts, says that permissions and limits are counted per service, and says to create a second mission.
- **An owner of an account can close the missions that stopped on it for want of an
  owner.** The account's page lists the missions that use it — name, who created it,
  its state — and offers "Close" on one that stopped that way, which stops it for good
  (you type its name). A mission that runs is still its creator's alone.
- **"Give access" lists the missions an access would bring back.** Giving access
  again to someone whose missions had stopped restores those missions at once, with the
  key their agent still holds. The dialog now names them, with who created each, and
  gives the access only once you have confirmed that list.
- **"Reset the count" resets the one permission that reached its limit.** It used to
  put every counter of the mission back to zero, so answering for one permission
  silently reopened any other that had reached its limit. Each has its own request.
  "Give back some calls" is unchanged: at most what the period used on that permission.
- **Activity shows more to two people.** A **teammate** on a mission now reads that
  mission's entries (calls, changes, requests) for as long as they are on it. An
  **administrator** now reads every entry of the instance, calls included, where they
  used to read administrative acts only. Neither is shown arguments — the record never
  holds them — nor the fingerprint that stands for them, which stays with the mission's
  creator and the account's owners.
- **Upstash Redis: a time to live and a move are deletions.** `EXPIRE` with any
  TTL, `SETEX`, `SET … EX`/`PX` (and `upstash_redis__set` with `ex` or `px`),
  `RENAME`, `LMOVE`, `SMOVE` and `RPOPLPUSH` now need `delete-data` next to
  `write-data`: a one-second TTL removes a key as surely as `DEL`. **A mission that
  holds `write-data` alone can no longer write a cache entry with a TTL**; add
  `delete-data`, which the Developer and Operator presets already carry. With the
  Operator preset, a TTL write on a prod database now waits for approval. The plugin
  is `3.0.0`, its catalog `5`.
- **Supabase: reading `auth`, `vault` or `storage` through SQL is a risk of its
  own.** `supabase__execute_sql` now needs `supabase[<env>].read-managed-schemas`
  on top of `supabase.read-data` when the query names a schema Supabase manages, and
  also when the gateway cannot read the query with confidence: a call to a function
  it does not know to be inert (any function of your application), `$$`, a
  parameter, a statement that is not a plain query. A mission that holds `read-data`
  alone keeps running plain queries on application tables; anything else is refused
  `risk-not-accepted` until its creator adds the risk. The **Read-only analyst**
  preset does not carry it; **Staging developer** does, on staging. Missions issued
  before this build do not hold it. The Supabase plugin is `4.0.0`, its catalog `4`.
- **Supabase missions.** A migration that changes a column type now needs
  `bulk-row-write` on top of the schema write. `supabase.row-write-one` is
  deprecated: it matches no call and grants nothing; missions and shares that name
  it keep working.
- **Supabase's "Staging developer" preset no longer reads the managed schemas.**
  `supabase[staging].read-managed-schemas` (the `auth`, `vault`, `storage` internals
  through SQL) is ticked on purpose now; missions already created keep the explicit list
  they were created with. Plugin `@vaubaan/plugin-supabase` 4.1.0, catalog 5.
- **Every catalog whose wording changed has a new `catalog_version`** (dated
  2026-10-14): cloudflare-dns 3, github 5, gmail 4, railway 4, resend 4, ssh 4, stripe
  5, supabase 5, upstash-redis 6, vercel 3. No id, vector, limit or gate moved.
- **A replaced machine key is answered `token-rotated`**, as a replaced personal key
  is (it was `token-revoked`, since the page revoked it before making a new one).
- **A sign-in can now be refused with `groups-unavailable`.** When the ID token
  carries no groups claim and the userinfo request fails, the sign-in is refused
  instead of signing the user in with no group. Sessions already open are not
  affected; trying again once the identity provider answers is the remedy.

### Added

- **An account carries a default environment for its unlabelled resources.** On the
  account's page, "Default environment for unlabelled resources" (none, or one of the
  environments the service's permissions know: `staging`, `preview`, `prod`…) gives
  every resource without a label of its own that environment, including the ones found
  later — a Fly organization or a Railway workspace no longer needs each new app labelled
  by hand before a mission can act on it. A resource's own label, the owner's or the
  service's (Stripe `test` / `live`), always wins; "none" keeps the earlier behaviour.
  Mission issuance, the execution door and `list_my_connections` (new
  `env_qualified_risks.default_env`) all read the same effective label. Owner only,
  recorded in the activity (`connection-default-env-set`); migration `0017` adds
  `connections.default_env`. ADR `connection-default-environment-label`.
- **A mission can be given a whole account, including resources found later.**
  Creating a mission, "Change" beside an account's resources now offers three
  choices, each explained in one line: _Every resource known now_ (the default,
  unchanged: a resource found later is not reached), _The whole account_
  (every resource of the account, today and found later, except the hidden
  ones) and _Only the ones I pick_. A mission given a whole account reaches a
  resource as soon as the account's discovery returns it — no new mission, no
  new key — and stops reaching one discovery no longer returns. The mission
  page, the setup kit, `list_my_missions` and the activity
  (`mission-issued`: `resource_scope` per account) say it. On the management
  door, `preview_policy` and `issue_mission` accept
  `resources: { scope: 'connection' }`; `all` keeps meaning "known now". A
  permission tied to an environment is checked against the resources known when
  the mission is created; a resource found later gets it once it carries its
  environment label, its own or the account's default (notice
  `later-resources-need-env-label`). Missions created
  before keep exactly what they reached. Schema migration `0018` applies at
  start (ADR mission-reaches-the-whole-connection-on-request).
- **A failed CI can be diagnosed through the gateway** (`@vaubaan/plugin-github` 3.3.0,
  catalog v8). `github__list_workflow_jobs` lists the jobs of a workflow run — name,
  status, conclusion, steps with their conclusions, link, start and end — and
  `github__get_job_logs` returns the log of one job as plain text, at most `max_bytes`
  (64 KiB by default, 1 MiB at most); `tail: true` keeps the end of the log, and the
  answer says when it was truncated. Both are reads of `github.read-meta` (two patterns
  added) under the App permission Actions (read), which the App already asks for. The
  log's short-lived download link is followed without the installation token and is
  never logged.

- Creators can add or remove mission permissions without replacing keys or
  resetting usage. Agents can explicitly request missing permissions after a
  refusal; the creator reviews and grants the edit or refuses it in Waiting for
  you. Requests are bound to the refusing key, deduplicated and rate limited.
- **The master key is generated by the instance and handed to the administrator.**
  With `VAUBAAN_MASTER_KEY_FILE=/data/master.key` and `VAUBAAN_MASTER_KEY_GENERATE=1`
  (`encryption.generate_master_key`), the first start writes the key file on the data
  volume (32 random bytes, base64, mode 0600) and boots; nothing to generate by hand
  before `docker run`. Nothing is generated once the store holds data — a missing key
  on an existing store stops the start (exit 78) — nor with `VAUBAAN_RESTORE_FROM`, nor
  for a key given by value. The setup then starts with one step, before the sign-in
  provider: "Download your encryption key", and the box "I kept it in a safe place —
  without it a backup of this gateway cannot be opened" to continue. Later,
  Administration → Encryption shows where the key comes from and offers "Download
  the key" to an administrator who signed in less than ten minutes ago. Every
  download is recorded in the activity (`master-key-downloaded`: who, when, from which
  page), never the key. `deploy/config/.env.example` ships with the generated key;
  `npm run gen-master-key` stays for whoever provides it. ADR
  `master-key-generated-and-handed-over-by-the-instance`.
- **Moving an instance to a new host without a shell: the setup receives the key.**
  With `VAUBAAN_RESTORE_FROM` set, an empty volume and no key file, the gateway
  starts in setup mode instead of stopping: `/healthz` says `setup`, every page leads
  to `/admin/bootstrap`, which asks for the bootstrap token and the key file the
  former instance handed out. The key is written on the volume, the copy is checked
  with it (hash, integrity, schema, every stored secret opens) and restored, and the
  gateway serves; a key that does not open the copy is removed again and the page
  says which check failed. Same ADR, amendment.
- **Restore, and moving an instance to another host.** `node apps/gateway/restore.mjs
<file or https URL> --sha256 <hex>` puts a copy made by `backup.mjs` back after
  checking its SHA-256, SQLite's integrity check, a schema this image can migrate (an
  older one is fine, a newer one is refused) and that the instance's master keys open
  every stored secret; `--dry-run` checks only; a store that exists is replaced only
  with `--force`, gateway stopped, and is kept aside, never deleted. A new instance can
  start from a copy with no shell: `VAUBAAN_RESTORE_FROM` (a file path or an https URL,
  a secret never logged; http refused) and `VAUBAAN_RESTORE_SHA256` make its first boot
  restore the copy before opening the store; a refused restore stops the boot and
  writes nothing, and once the store exists the variables only bring a warning.
  `VAUBAAN_RESTORE_MAX_MB` caps the copy (1024 by default). The procedure, new key and
  reseal included: `deploy/railway.md` §9. ADR
  `restore-verifies-before-it-replaces-and-runs-at-first-boot`.
- **Fly.io plugin** (`@vaubaan/plugin-fly` 0.1.0, catalog 1): the apps of one Fly
  organization — machines, images, volumes and snapshots, secrets, IP addresses,
  certificates and logs — through the Machines API, with an organization token checked
  against the organization it names. Presets `read-only`, `operator`, `fleet-upgrade`,
  `provisioner`. Machines only run images pinned by digest under the account's allowed
  prefixes (default `ghcr.io/vaubaan/gateway`); an image change needs a snapshot of
  every mounted volume taken in the last hour; secret values are never read back;
  destroying an app or a volume, writing secrets and running a command inside a machine
  ask first in every preset. Handbook `providers/fly`.
- **Secret values are masked on an approval page.** A plugin names the arguments that
  carry secrets (`secretArguments`); the page shows each value as a short fingerprint
  and keeps the names. ADR `secret-arguments-masked-in-the-approval-view`.
- **An instance on Fly protects its own app**: `fly:$FLY_APP_NAME` is one of its self
  resources, as `railway:$RAILWAY_PROJECT_ID` on Railway, never reachable by a mission.
- **Notion plugin** (`@vaubaan/plugin-notion` 0.1.0): pages, page content, databases and
  comments of the top-level pages and databases shared with an internal connection token
  (`api-key`; personal access tokens refused), every id proven under its root before a
  call reads or writes, writes sent silently; presets `read-only`, `reviewer` and
  `editor` (moving a page to the trash and deleting a block ask first).
- **Import from the hosted product (v4), once per organization.**
  `scripts/export-v4.mjs --org <slug>` reads one organization of the v4 database
  (read-only, through `psql`) and writes a bundle to stdout only; piped into
  `node apps/gateway/import-v4.mjs --owner <email> [--apply]` inside the instance's
  container (`docker compose exec -T`, or `railway ssh … -- vaubaan-entrypoint …`),
  it creates under that person the Cloudflare, Vercel, Stripe and SSH accounts
  (each key checked at the service first; the SSH host's fingerprint given by the
  operator), carries the resources' environment labels when they are `prod`,
  `staging`, `preview` or `dev`, and issues one mission per working v4 key with its
  permissions translated one by one — never widened, v4 denials honoured, a Stripe
  project kept to the mode it used, limits from the plugin's presets — printing each new mission key once on stdout. GitHub, Railway and
  Supabase are connected by hand; a mission waits until its services are there and
  the next run issues it. The default is a dry run; a bundle older than an hour is refused; a second run
  never duplicates (missions are recognised by their v4 token, not their name).
  Every act is the owner's in Activity, marked `imported-from-v4`. Handbook
  `import-from-v4`, ADR `import-from-v4-one-shot-importer`.
  `--carry-unbudgeted <quota>` keeps, instead of dropping, a v4 permission no
  preset gives limits: with that quota per day and **ask me first** on every use.
  `--reissue <v4 token id>` issues a new mission for a v4 key already imported
  (to add permissions, which an issued mission never gains); the earlier mission
  keeps working and the report names it, to revoke once the new key is installed.
  The dry run checks each mission as if the environment labels it would set were
  set (it writes none), so a mission that needs such a label reads "would be
  issued", as `--apply` then issues it.

- **The gateway is the agent's git remote.** With a mission key and git, and
  nothing else, an agent clones, fetches and pushes
  `https://<instance>/git/<owner>/<repo>.git` (GitHub, through the company's App or
  a token connection); the key is the password, read by a credential helper from
  `VAUBAAN_MISSION_TOKEN`. A clone is relayed as a stream (protocol v0, v1, v2) and
  counted once as `github__git_fetch`. A push is decided ref by ref, every ref of
  it, as one call `github__git_push`: which branches and tags, rewrites, deletions
  and CI workflow changes, against the mission's permissions and limits; one
  refused ref refuses the push, and git prints why, with the URL to hand to a
  person. The pack is streamed to GitHub under a temporary ref, never stored or
  read by the gateway; the refs move through GitHub's API once decided. An
  approved push is replayed by pushing the same commits again; the request page
  links GitHub's comparison. Refused, with a sentence: atomic pushes, push options,
  signed pushes, more than 50 refs, a pack over `git.max_pack_mb` (default 200),
  a push GitHub cannot compare in full (300 files or 250 commits per ref), Git LFS.
  What a push brings is reviewed from the nearest branch it was built on, so a new
  branch off a line of work that diverged from the default branch is not refused for
  the size of that divergence.
  New configuration keys `git.max_pack_mb` and `git.request_timeout` (default
  10 minutes). The setup kit has a fourth step (git's configuration and the
  remotes), the mission page a "Git" block (can, asks first, cannot), the GitHub
  reference page and `/agent-bootstrap.md` a "Git" section, and `/mcp/catalog` a
  `git_remote` per repository. GitHub catalog v6 adds `github.git-push`,
  `github.force-push`, `github.branch-delete` and `github.tag-write` (plugin
  3.1.0).

- **Create the company's GitHub App from the gateway.** Settings → Company apps →
  GitHub offers "Create the GitHub App" while none is set: choose the owner (an
  organisation or your own account), the name (`Vaubaan <host>` by default) and the
  permissions it requests — by default what the tools need, with Contents write,
  Administration and Workflows explained as sensitive and each permission saying which
  tools stop without it. GitHub's App manifest flow does the rest: GitHub shows the App
  and asks you to confirm, and the App's id, key and secrets come back stored
  encrypted, never shown — nothing to copy. The page then shows the App (name, owner,
  link, permissions) and "Install it on your repositories". The form to enter an App
  registered by hand stays one click away; an App set in the configuration stays
  read-only. Every gateway has its own App, never a shared one: a shared App's key would
  mint tokens for every customer's installations (ADR
  company-app-created-from-a-manifest).
- **A GitHub call the App has no permission for is refused by name**, before anything
  is sent (`github__create_branch needs the GitHub App permission Contents (contents:
write …)`), instead of GitHub's bare 403. The push token of
  `github__mint_install_token` carries `pull_requests` and `workflows` only when the
  installation holds them.
- **Connect GitHub, Supabase and Railway with a token, beside the company app.**
  When an administrator registered the service's app, people connect through it as
  before, and "Use a token instead" is one click away; when not, the token is the
  way, with a guide read from the plugin: where to create it, the permissions to
  tick and the tools each serves, the expiry to choose, and what a token cannot
  run. GitHub takes a fine-grained personal access token only (a classic `ghp_`
  token is refused); `github__mint_install_token` needs the App and is neither
  listed nor run on a token account. Supabase takes a personal access token (a
  scoped one is recommended) and runs every tool with it. Railway takes a workspace
  token (recommended: one workspace only) or an account token, and runs every
  tool with it, the ten tools of Railway's MCP server included (the token is sent
  to it as a Bearer; checked with a workspace token on 2026-10-14). When that
  server refuses a token Railway's API still accepts, the call fails naming the
  kind of token and the account stays usable; a token refused everywhere makes
  the account "Needs reconnecting". A pasted token is checked at the
  service before it is stored, the account page says who it acts as and when it
  expires, ahead of it, and removing the account says where to delete the token
  (no service offers an endpoint the gateway may use for it). A shared service
  account is fine: Activity says which person and mission made each call. Plugin
  authors: `alternativeCredentials`, `unavailableTools`, and the `label`, `guide`
  and `verify` of an `api-key` spec (ADR
  `token-connections-beside-the-integration-app`). Plugins: github 3.1.0,
  supabase 4.2.0, railway 4.2.0.
- **Several sign-in providers on one instance**, OpenID Connect and GitHub: a
  company directory (Entra ID, Google Workspace, Okta, Keycloak) and people who
  sign in with their own account (personal Google or Microsoft, GitHub), at once.
  Configured as `sign_in.<id>.*` (`VAUBAAN_SIGN_IN_<ID>_<FIELD>`) beside `idp.*`, or
  added, edited, tested and removed on Settings → Sign-in (audited, the secret never
  shown back; a provider of the configuration is read-only there). The sign-in page
  shows one button per provider; each has its callback,
  `<public_url>/auth/callback/<id>`. A sign-in started with one provider is never
  completed by another's response. **Identities never merge by email**: one person
  through two providers is two people, and the People page says so.
- **GitHub sign-in** (an OAuth App, with state and PKCE): the person is GitHub's
  numeric user id, their email the primary address GitHub verified; `read:org` is
  asked only when the admin rule names a team (`github:<org>/<team>`). A GitHub
  Enterprise Server works through its base URL.
- **Invitations**: administrators invite and remove email addresses on Settings →
  People (audited). A sign-in is admitted on a verified address in the provider's
  allowed domains, on the invitation list or in `admin.emails`; a company
  directory without domains admits everyone it signs in, a provider where anyone
  can hold an account never does.
- **Removing a sign-in provider** ends its people's sessions at once and stops
  their sign-in; their missions and connected apps run until an administrator
  deactivates them.
- **Security headers set by the gateway itself** on every response: a
  Content-Security-Policy that admits only the gateway's scripts (a nonce per
  response) and forbids framing, `X-Frame-Options`, `nosniff`, a same-origin
  referrer policy, a permissions policy granting no device, and HSTS.
- **Railway**: `deploy/railway.md`, and an image entrypoint that, started as root
  on a root-owned volume (`RAILWAY_RUN_UID=0`), gives `/data` to the gateway's user
  and runs the server as that user, without capabilities.

- **Change limits.** The creator of a mission raises or lowers, per permission it
  holds, the limit per period and the calls per minute, from the mission page
  ("Change limits", then a confirmation listing each change). It applies from the
  next call, in the current period: what was used stays used, and a limit under it
  stops the permission until the reset. A change is capped exactly as a creation is
  (what you may allow on the account, the service's own ceilings), never adds or
  removes a permission, never touches the period or "ask me first", and is one line
  of the activity with the limits before and after. A connected app cannot do it.
  The limit-reached page now leads there ("change the limit") instead of to a copy of
  the mission. `POST /api/missions/<id>/limits`.
- **Leave a mission.** A teammate leaves a mission from its "···" menu, after typing
  its name; their key stops at once (`holder-removed`) and the mission is no longer
  theirs to see. The creator stops a mission instead. `POST /api/missions/<id>/leave`.
- **Replace key on a machine key is one act.** The old key is retired and the new one
  issued together, so there is no moment without a key or with two.
  `POST /api/missions/<id>/tokens/<tokenId>/replace`.

- **A redesigned interface, and one vocabulary.** A short side navigation: Now, Waiting
  for you (with the count of what waits), Missions, Accounts, Activity, Reference, then
  Settings, with your name and the theme at its foot; it collapses to its icons in a
  narrow window. Administration is part of Settings and keeps the same navigation.
  Every page was rebuilt on one design system and says the same words (see "Words"
  above). A default view shows what you would act on — one primary action, a limit
  drawn only when it is near, colour for an exception only — and the rest is one click
  away behind "Show details" and "why?", which a page remembers.
- **Now, the one home.** What waits for you first, each request with who asks, on which
  mission and the room left; then what is running, one line per mission; then counts
  that lead elsewhere. When nothing waits, one sentence says so. Someone who created no
  mission reads what the product is and the steps to a first account, a first mission
  and the kit; an administrator reads what is left to set up. A yes is never given from
  the home: "Review" leads to the request, where the exact call is shown; "Refuse",
  which runs nothing, is on the row.
- **Light and dark themes.** Light by default; a toggle at the foot of the navigation,
  and Settings, choose among System, Light and Dark. The choice is kept in a cookie
  (`vaubaan_theme`, a display preference and nothing else) so that a page never
  flashes in the other theme while loading.
- **An interface reference at `/design`** (listed in Settings for administrators;
  reachable by its address for anyone signed in): every component of the interface in
  every state, in both themes, with invented data.
- **The interface on a phone.** The navigation is a bar at the bottom of the screen
  with a word under each icon — Now, Waiting, Missions, Accounts, and "More" for
  Activity, Reference and Settings. A table is drawn as rows of labelled lines instead
  of a grid, the actions of a row are always visible (nothing depends on hovering), a
  dialog never exceeds the screen, and no page scrolls sideways.
- **An approval says what the agent wants to do.** A request that waits for your yes
  is headed by what the tool does and the resource the call resolves to — "Merge a
  pull request · acme-org/app" — on Now, in "Waiting for you" and on the mission; the
  permission it needs, its severity and the exact arguments are right below. A plugin
  gives each tool a few words (`toolTitles`, optional: a tool without them is headed
  by its name); `tools/list` is unchanged.
- **One form for dates.** "14 Oct", "14 Oct, 01:48", on 24 hours and in your time zone,
  whatever the language of your browser.
- **A change in the activity is read in words**: the account by its name, each
  permission with its limits, what a value was before. The stored record is one click
  away ("Show the raw record").
- **Signing in lands on Now**, and a form that refused a key comes back with what you
  typed, the field in error marked and its expected shape said again — a key itself is
  never kept: you type it again.

- **The execution door.** `POST /mcp` takes a mission token: `tools/list` shows the tools
  of the providers the mission holds a connection and an accepted risk for; `tools/call`
  checks the mission's state, its resources, that the risks the call touches are among the
  accepted ones, the budget, the rate limit and the gate, calls the provider with a
  credential decrypted for that call only, and writes one audit entry, allowed or refused.
  Stateless Streamable HTTP (`@modelcontextprotocol/server` 2.3), plain JSON unless the
  call asked for progress, rate limited per mission (`mcp.rate_limit_per_minute`, 600).
  `GET /mcp/catalog` returns what the mission can call, its resources with their
  environment labels, what is left of each quota, whose token is presented and who
  created the mission.
- **Eight structured refusals.** `risk-not-accepted`, `budget-exhausted`,
  `approval-required`, `resource-not-in-mission`, `rate-limited`,
  `connection-unavailable`, `mission-inactive` and `wrong-credential-kind` reach the
  client whole: a JSON-RPC error whose `data` carries the code, its fields (claim URL,
  approval URL, allowed resources…) and a hint an agent can act on. The gateway never
  holds a call waiting.
- **Missions.** Whoever owns an account or was given access to one creates a mission on
  one screen: a name; accounts and resources; per account a preset — each says what it
  yields within what you may allow, and why when it would allow nothing — or "Edit the
  permissions one by one", every permission you hold with its limit per period, its
  limit per minute and "ask me first", grouped into reads, writes and writes that cannot
  be undone, with a search box; how often the limits reset and an optional end. A rail
  says, as the form changes, what the mission can do, what asks you first and what it
  cannot. **"Create mission" asks once and lists every permission with its limits**:
  what a mission stores is always that explicit list, never a preset and never "all". A
  mission can start from a copy of another ("Start from a mission…", "Duplicate") or
  from a JSON proposal an agent wrote. Creation refuses anything beyond what its creator
  may allow, and the preview warns when a selected resource has no usable environment
  label. The missions list and the page of a mission say when it was created
  ("created 2 h ago", the exact time on hover), and the page shows its short id (the
  last 8 characters of its id, as the importer's report names it too), so that two
  missions of the same name are told apart and matched with a report or Activity. The creator stops a mission from the bottom of its page too ("Stop this
  mission": what stopping does, then the same typed confirmation as in "···").
- **Keys, teammates and the setup kit.** A mission has one or more keys (`vbn_live_…`,
  stored as a SHA-256 digest), each with one holder. The creator adds colleagues as
  **teammates**; each generates their own key, shown once with the setup kit — the
  creator never sees it — and the creator makes **machine keys** for a CI runner or a
  shared machine. Every key shares the mission's resources, permissions and **one set of
  limits**. A teammate uses the mission as it is and manages only their own key; the
  creator can revoke any key and remove a teammate. **"Replace key" asks first and says
  that the current key stops working at once**; revoking a key, removing a teammate and
  stopping a mission are confirmed by typing a name. The kit holds the environment
  variable (`VAUBAAN_MISSION_TOKEN`), an `.mcp.json` that references it, instructions
  for each refusal and a `curl` check; `/agent-bootstrap.md` documents the same for any
  agent.
- **A token that stops says why.** A token that was rotated or revoked, or whose holder
  was removed from the mission or deactivated, is answered HTTP 401 with
  `error.data.reason` (`token-rotated`, `token-revoked`, `holder-removed`,
  `holder-deactivated`) at the next call, while the mission keeps serving its other
  holders.
- **Budget, sessions and rate limits.** A call touching several risks decrements all
  their counters in one transaction, or is refused whole. Periods roll over on read; a
  one-off mission has a single open-ended period. The credit of an allowed call is not
  refunded when the provider fails. Rate limiting is in memory, for a single process.
- **A limit that was reached, and "Waiting for you".** The URL a `budget-exhausted`
  refusal carries, `<public_url>/r/<id>`, asks for a sign-in and lets only the mission's
  creator through. The creator resets the count, gives back up to what was used, extends
  the mission, or leaves it until the reset; the key does not change and the agent
  replays its call. "Waiting for you" lists what awaits you, the oldest request open
  beside the list; the same requests are on the home and on their mission, where a
  teammate reads whose answer the mission waits for. Unanswered requests expire after
  `requests.expiry` (24 h by default), on a mission without an owner too.
- **"Ask me first".** A call that needs a permission set to "ask me first" (the gate
  `approval`) is refused `approval-required` with the URL of a request. The creator —
  and nobody else, administrators included — reads who asks, the tool, the arguments in
  clear, the permission and what is left of every limit the call counts against, then
  approves that one call, lets the permission run freely until the limits reset, or
  refuses. A yes is given on the page of the request only. An approval is bound to the
  mission, the permission, the tool and the fingerprint of the arguments, is used once
  and expires after `approvals.expiry` (10 minutes by default). The arguments are kept
  encrypted while the request is open and erased when it is answered or expires. The
  creator can switch "ask me first" on a permission of the mission after creation, on an
  expired mission too; switching it back on ends a "run freely until the reset" given
  earlier in the period.
- **Agent labels: who did what, when several agents work on one mission.** An agent may
  label its calls with the `X-Vaubaan-Agent` header or, per call, with `_meta.agent`
  (which wins when both are sent). A label is 1 to 64 characters — letters, digits and
  `. _ - : / @ +`, starting with a letter or a digit; anything else is ignored, the call
  is served without a label and the gateway logs why. A label is attribution, never a
  credential and never a budget. The bootstrap kit tells an orchestrator to hand its MCP
  configuration to its sub-agents as it is.
- **The management door: an agent prepares a mission for a user.** The instance is an
  OAuth authorization server for `/mcp/manage`: an MCP client discovers it (RFC 9728 and
  RFC 8414 metadata), registers, and sends the user to sign in and to a consent screen
  that names the application as a claim, the single scope `mgmt`, what it covers and
  never covers, and where the access goes. Authorization code with PKCE `S256` only;
  opaque access tokens (15 minutes by default) and single-use rotating refresh tokens
  (30 days), stored as digests; a token grant is one transaction. A refresh token or a
  code presented twice revokes the whole delegation — except the refresh token rotated
  last, presented again by the same client within `oauth.refresh_reuse_window_seconds`
  (30 by default). Behind the consent the door offers seven tools
  (`list_my_connections`, `get_catalog`, `list_my_missions`, `preview_policy`,
  `issue_mission`, `rotate_mission_token`, `revoke_mission`), each with an output schema,
  each acting as the delegating user within their current authority. The door cannot
  answer a request, open a gate, extend a budget, touch a connection, a share or a group,
  or call a provider tool, and it rotates the token only of the missions it issued.
  Missions issued this way are marked with the application that issued them.
- **Connected apps and registered apps.** Under Settings → Connected apps a person sees
  the applications they authorized, until when each consent runs, where each sends its
  access and the missions it prepared, and disconnects one after a confirmation.
  `oauth.client_registration.policy` is `open`, `operator-approved` (default) or
  `closed`; under the default a client that can only return to the person's own machine
  needs no approval, any other waits for an administrator under Settings → Registered
  apps, where an app can also be disabled, which disconnects it from everyone. Client ID
  Metadata Documents are supported and off by default.
- **Three credentials that never cross.** A mission token opens `/mcp` only, a delegated
  token `/mcp/manage` only, a browser session the interface only; each is refused with
  `wrong-credential-kind` at the other two, naming the door that accepts it.
- **Sign-in through your identity provider.** Any OpenID Connect provider signs people
  in (discovery, PKCE, state and nonce, configurable `sub` / `email` / `groups` claims,
  optional allowed email domains). A user is the pair (issuer, subject). Groups claimed
  by the identity provider are replaced at every sign-in; local groups are untouched.
  Sessions are server-side, 8 hours at most, behind a `__Host-` cookie, with an origin
  check on every mutation.
- **Bootstrap and administration.** `/admin/bootstrap` accepts the configured bootstrap
  token while no identity provider is set; the first administrator sign-in revokes it.
  Afterwards an administrator is whoever matches the admin rule, recomputed on every
  request. Administration is part of Settings: Setup (a checklist of what the gateway
  still needs), Sign-in, Company apps, People, Teams, Accounts without owner, Telemetry
  and Registered apps.
- **Accounts and resources.** A signed-in person connects an account of a service
  through one generic driver for the four credential kinds (`oauth2`, `app-install`,
  `api-key`, `ssh-key`); a field that takes a key says the shape it expects. An account
  (a connection) is `active`, `expired` ("needs reconnecting"), `revoked`
  ("disconnected") or `unowned` ("needs an owner"); the gateway refreshes OAuth tokens
  itself, so a plugin never sees the client secret. Plugins discover resources at
  connect time and on "Refresh"; the owner renames them, labels their environment and
  hides them, and those edits survive a new discovery. The page of an account says who
  has access and up to what, what it reaches, and which missions use it.
- **Company apps.** Administrators register the app the company holds at each service
  under Settings → Company apps (secrets encrypted in the store) or under
  `providers.<id>` in the mounted configuration, which wins and makes the page read-only
  for that service. A service that also connects with a token (GitHub, Railway,
  Supabase) says that its app is optional and leads to the token way and its guide;
  Setup and the home's checklist no longer count such a service as missing.
- **Access, teams and ownership.** The owner of an account gives access to a person or
  a team ("Give access", a dialog over the account): who, then a checklist of the
  service's permissions. "Select all" ticks today's permissions one by one; what is
  stored is that list, and a permission added to the catalog later is not part of it.
  Several accesses to one account add up, and "Shared with you", on Accounts, lists
  what you were given with the exact permissions. An owner hands an account to a team
  they belong to. When the owning team has nobody left the account "needs an owner"
  (`unowned`): it keeps serving the missions that still have grounds, and an
  administrator names a new owner — their only act on an account. Removing an access,
  handing an account over and disconnecting it are asked first, with how many missions
  would stop.
- **Missions without an owner, for as long as the authority is missing.** A mission
  whose creator may no longer allow its permissions — an access removed or narrowed, an
  account disconnected, a team left, the creator deactivated — refuses every call with
  `mission-inactive` (`orphaned`). The state is computed from what the creator may allow
  each time it is read: when that comes back, the same mission serves again with the
  same keys and counters. A disconnected account never comes back. The mission page
  says why, and Activity shows the acts that stopped and restored it.
- **Administrators can deactivate a person** (Settings → People): no sign-in, sessions
  ended, connected apps cut off, the person's missions refused, their keys on other
  people's missions revoked, their accounts handed back for a new owner — without
  waiting for the identity provider. The act is asked first, with what it stops.
  Reactivating first closes anything a failed deactivation left open.
- **Activity: the audit record, its filters and its retention.** `/activity` lists one
  line per call, allowed or refused, and per change a person made, newest first, with
  filters by period, mission, account, tool, decision, person, key holder, agent label
  and kind of entry. Each line unfolds, at an address of its own, into its detail: the
  key used, the permissions touched and what is left, what the agent was told. A person
  sees the entries of the missions they created or work on and of the accounts they or
  their teams own; an administrator sees every entry; nobody sees arguments, only —
  for who answers for the call — their fingerprint (SHA-256 of the canonical JSON, the
  same value an approval is bound to). Every mutation leaves an entry. Entries older
  than `retention_days` (90 by default) are purged at start and then hourly.
- **The activity of a mission** ("Everything this mission did"). What waits for an
  answer, the calls of the current period per key holder and per agent label (counts
  for information: the limits stay per permission and shared), and the timeline of its
  events, which can be narrowed to one holder or one label; on demand, what each
  permission used and the counters of earlier periods.
- **A reference inside the interface.** "Reference" lists the services of the
  instance; each has a page generated from its plugin: what an account of it is, in
  plain words, then three tabs. **Permissions**: one table, the permissions against the
  presets — a row per permission, grouped into reads, writes and writes that cannot be
  undone, a column per preset, each cell the limit the preset gives and whether it asks
  first; "why?" unfolds the reason, the six words behind the severity, whether the
  permission is held once or per environment and what it covers. **Tools**, as a table.
  **How it is modelled**, as an outline. A service whose model has several parts
  (Supabase: db, storage, auth, functions) gets a filter that narrows every tab at once.
  Every permission shown on a mission, a request, an access or an account links to its
  entry.
- **One way to read a permission.** On every page a permission is what it allows in
  words, its severity as one word, and its id as the protocol spells it, in a monospace
  face; "why?" unfolds the reason and the six words behind the severity (undo, blast
  radius, data, cost, visible to, lasts). Nothing is coloured by its kind any more:
  amber means "needs you", red means "stopped, refused, limit reached". Page help is
  one sentence under the title.
- **Streamed tool results.** A plugin whose provider answers progressively can hand the
  parts of its result to the gateway as they arrive (`ExecuteContext.emitPart`,
  `streamToolResult`, `textParts`); an MCP client that sent a progress token receives
  each part as a progress notification, then the complete result. The decision and the
  budget decrement always come before the first byte. No shipped plugin streams yet.
- **Community telemetry (opt-in).** Off at installation. An administrator enables it
  under Settings → Telemetry, which shows the exact payload first: plugin, plugin
  version, gateway version, tool, outcome (`success`, `upstream-error`,
  `classification-error`, `execution-error`), a fixed-vocabulary error class and the
  call's duration as one of four buckets — never arguments or their hash, resource
  refs, mission or user identifiers, an instance identifier, an address or a
  provider's message. The built-in collector URL (`https://telemetry.vaubaan.com/v1/reports`)
  is still gated as a placeholder: nothing is sent until a release publishes it or
  `telemetry.collector_url` names another collector. The project's collector is
  `deploy/collector/schema.sql` (the store) behind the site's endpoint
  (`apps/website`). `telemetry.level` (`VAUBAAN_TELEMETRY_LEVEL`) chooses what an
  enabled instance sends: `plugin-health`, or `usage-stats` (the default), which adds
  one decision per call (allowed or the refusal code, the risks touched without their
  environment, whether it asked first) and one profile a day (version, where it runs,
  runtime, sign-in kinds, and counts of people, missions, accounts and calls as
  ranges), with an identifier drawn again every day and sent with nothing else.
  A collector of your own now receives `{"plugin_health": [...]}` instead of a JSON
  array.
- **Embedded store and encryption at rest.** SQLite (`better-sqlite3`, `STRICT` tables,
  WAL) with forward-only migrations applied at start (schema version 11) and an
  append-only audit enforced by triggers. The gateway refuses a database newer than the
  image. Credentials are encrypted with XChaCha20-Poly1305 under a key derived per
  connection from the master key; `npm run gen-master-key` generates one.
- **Configuration.** The gateway starts from `VAUBAAN_*` variables and/or a mounted YAML
  file (`VAUBAAN_CONFIG_FILE`, the file wins key by key; `${NAME}` / `${file:/path}`
  secret references, `*_FILE` variables). A missing or invalid key stops the process
  with exit code 78 and a message naming every key and its variable.
- **Docker image and deploy kit.** `deploy/docker/Dockerfile` (Debian slim, non-root,
  `/data` volume, healthcheck, no `.env*` file and no test file in the image),
  `deploy/compose.yaml` with a Caddy TLS proxy that sends the security headers and
  receives none of the gateway's secrets, base images pinned by version and digest, and
  documented examples of the configuration. `GET /healthz` answers; the version and the
  commit are in the footer of every page, the consent screen included; logs are JSON
  lines with token-prefix and secret redaction.
- **Releases.** Pushing a tag `v2.x.y` publishes the image for `linux/amd64` and
  `linux/arm64` to `ghcr.io/vaubaan/gateway` with an SBOM and a signed build-provenance
  attestation, and creates the GitHub release from this file. From a private
  repository — a fork kept private, or this one before it is public — a release is
  `linux/amd64` only and unattested, because GitHub reserves the arm64 runner and
  artifact attestations for public repositories; the run summary and the release notes
  say so, and everything else is the same. What a version number promises —
  configuration keys, refusal codes, the plugin contract, catalog ids — is written in
  `docs/workflow/coding-workflow.md`; pulling and verifying an image in
  `deploy/README.md`.
- **`npm run demo`: the whole interface in your browser, nothing to register.** One
  command starts the real application on `http://localhost:3210` with a demo identity
  provider (a picker of three people, no password), simulated GitHub, Stripe, Cloudflare
  DNS, Resend, Upstash Redis and Vercel, and seeded accounts, accesses, missions in
  every state, requests waiting and activity; it prints a tour, in the interface's
  words, with ready-made `curl` commands. It builds the application on the first start and again only when the
  sources changed. Development only: it refuses a production environment, is not part
  of the image, binds the loopback interface and deletes its data on exit.
- **Plugin SDK and test kit.** `@vaubaan/plugin-sdk`: the `ProviderPlugin` contract and
  `definePlugin()`, the four credential specs, the registry every provider list derives
  from, the optional `envOf` hook, `summary` and `tokenHandouts` for the provider
  reference, `UpstreamHttpError` for a provider failure, and — for what an executor
  declines by itself — `ExecutorRefusal`, `declining()` and `refusalResult()`.
  `undeclaredArgumentDenial()` closes the argument surface of a tool; `identSegment()`
  writes an identifier into a slice, or "any" when the slice grammar cannot carry it;
  `NO_SINGLE_ENV` is what an `envOf` returns when a call names several environments.
  Each plugin ships a `risk-catalog.yaml` with presets and exactly one fallback entry.
  The test kit provides `mockFetch`, `assertPluginWellFormed`, `assertCatalogCoverage`
  (which also checks that every sampled slice reads back as itself), `assertNoWildcard`,
  `assertPresetsValid`, `declaredOnly` and `refusalText`. `plugins/_template` is the
  scaffold and `plugins/README.md` the step-by-step guide.
- **Provider plugins.**
  - **GitHub** `3.0.0` — a company GitHub App; a per-call installation token scoped to
    the repository; one resource per repository. Presets `read-only`, `developer`,
    `release-manager`.
  - **Vercel** `3.0.0` — access token and team id; one resource per project; the
    environment is read from the call. Presets `read-only`, `developer`, `operator`.
  - **Supabase** `4.0.0` — OAuth against the Management API; resources from the
    account's projects; env-scoped write risks; `execute_sql` on the read-only endpoint.
    Presets `read-only-analyst`, `staging-developer`, `migration-operator`.
  - **Railway** `4.0.0` — OAuth with PKCE; one resource per project with its
    environments and services. Presets `read-only`, `developer`, `operator`.
  - **Cloudflare DNS** `3.0.0` — a zone-scoped API token; one resource per zone; record
    writes split into ordinary, critical (apex, wildcard, MX, NS) and deletion. Presets
    `read-only`, `dns-operator`, `zone-admin`.
  - **SSH** `2.0.0` — an ed25519 pair generated by the instance and a pinned host key;
    `ssh__exec` classified by a shell lexer; a line it cannot see through is never a
    read. Presets `read-only`, `developer`, `operator`.
  - **Upstash Redis** `3.0.0` — account email and Management API key; one resource per
    database; every Redis command in exactly one class. Presets `read-only`,
    `developer`, `operator`.
  - **Stripe** `0.4.0` — optional test and live keys, one resource per mode, every risk
    scoped on the mode. Presets `read-only`, `test-mode-developer`, `finance-operator`.
  - **Resend** `0.3.0` — one resource per sending domain and per segment; sends are
    rooted at the `from` domain and classified by recipient zone. Presets `read-only`,
    `developer`, `marketing-operator`, `domain-admin`.
  - **Gmail** `0.3.0`, experimental — classifier only: no tool is exposed.
- **Context7 plugin** (`@vaubaan/plugin-context7` 0.1.0): agents look up library
  documentation through the gateway. The official Context7 MCP server is rewrapped
  (`resolve-library-id`, `query-docs`, frozen from its `tools/list`); a Context7 API
  key is the account, checked at Context7 before it is stored, and one resource, the
  library index it can query. One permission, `context7.query-docs` (the agent's
  question is sent to Context7), preset `read-only`. No environment. Arguments the
  tools do not declare are refused, the upstream server's aliases included.
- **Miro plugin** (`@vaubaan/plugin-miro` 0.1.0): boards, items, frames, connectors and
  tags; the non-expiring access token of a Miro app (`api-key`); one resource per board,
  no environment; bulk creation of up to 20 items as its own permission; presets
  `read-only`, `scribe` and `facilitator` (every deletion asks first).
- **Project files.** `LICENSE`, `CONTRIBUTING.md` (from a fresh clone to a pull
  request), `CODE_OF_CONDUCT.md`, `SECURITY.md` (private reporting, scope, trust model),
  four issue forms and a pull request template; `docs/handbook/threat-model.md` lists
  the actors, the controls and the test behind each; `docs/handbook/known-limitations.md`
  lists what has not been done.

### Changed

- **A permission granted on the GitHub App is seen at the next call or push**, not
  when the cached token expires (up to 50 minutes). A cached installation token that
  lacks what a call or a push needs is minted afresh once before anything is declined;
  a call or a ref move GitHub refuses for a missing permission ("Resource not
  accessible by integration", "… without `workflows` permission") is tried once more
  with a token minted afresh, then refused by the permission's name.
- **A git push that changes `.github/workflows/` is refused before its pack leaves**
  when the installation's token lacks Workflows: `github__git_push needs the GitHub App
permission Workflows …`, with nothing sent to GitHub (it used to be stored at GitHub
  first and refused there). The mission is asked first: a mission without
  `github.workflow-write-via-file` is refused for that permission, whatever the
  installation holds. The plugin SDK's git remote gains an optional `admitPush`, asked
  after the mission's decision and before the store (amendment of 2026-10-18 to ADR
  `git-push-inspected-before-it-leaves`); the review no longer reads the token.

- **GitHub plugin** (`@vaubaan/plugin-github` 3.2.0, catalog v7): `github.feature-branch-write`
  also covers `feat/*` branches (the Conventional Commits prefix), for branch, file and
  bulk writes and for `git push`; such a write fell to `github.uncategorized-write` and
  was refused on a mission without the fallback. The git remote's description of the
  permission now reads its branch list from the catalog.
- **`/healthz` reports the commit that was built, or `unknown`.** The Docker build no
  longer takes a `GIT_COMMIT_SHA` argument: `git archive` writes the commit it archives
  into `apps/gateway/build-commit.txt`, and the build reads it from there (a checkout:
  its own HEAD). A `GIT_COMMIT_SHA` variable on a Railway service is now ignored —
  delete it. ADR `deployed-commit-stamped-by-git-archive`.
- **Fly refusals and Activity name the account's organization**
  (`fly.org[vaubaan].app.W`, was `fly.org[*]` in a mission with no app). A plugin's
  classifier now receives the non-secret fields of the account's form; the permissions
  a call touches do not change. ADR `classify-sees-the-connection-public-fields`.
- **The Docker build no longer takes a `NODE_IMAGE` argument**: the base image is
  written, version and digest, on the first `FROM` line, so that Dependabot can propose
  its refresh. To build on another base, edit that line.
- **Licence.** Changed from proprietary to **Apache-2.0**. The last release of the
  earlier hosted product is tag `v4-final`.
- **One instance per company, on your network (breaking).** The gateway is a single
  process with an embedded store, behind your identity provider and your own provider
  apps. There is no hosted service, no organization or project tenant, and no data is
  carried over from the hosted product.
- **`/mcp` accepts mission tokens only (breaking).** The door re-reads the token, the
  mission and the creator's authority on every call. It answers no CORS and refuses a
  browser `Origin` other than the instance's own.
- **A budget and a gate per accepted risk.** A token of the hosted product carried a
  list of accepted risks; a mission stores each accepted risk with a quota, a rate limit
  and a gate. The fallback risk `<provider>.uncategorized-write` is touched only when no
  other catalog entry matches a write; in an audit log it means a catalog entry is
  missing.
- **Scope caps are not enforced in 2.0.** The execution door has no cap stage, so a
  shipped catalog declares only the limit the gateway enforces, the rate ceiling
  (`infra_limits.calls_per_minute_max`). A mission bounds a risk with its quota, rate
  limit and gate (ADR `scope-caps-not-enforced-in-v5-0`).
- **Only a 401 from a provider counts as a rejected credential.** The gateway then
  refreshes and retries once; a rejected refresh turns the connection `expired` and the
  agent reads `connection-unavailable`. A 403 is a failed call and leaves the connection
  alone. A revoked connection orphans its missions (`mission-inactive`).
- **Plugins throw provider failures and return their own refusals.** A provider failure
  is thrown with its HTTP status, so the audit summary and the telemetry class read
  `upstream-error` / `http_<status>`; what an executor declines by itself is an error
  result carrying a sentence the agent can act on.
- **Catalog versions.** `catalog_version` is 4 for GitHub, Stripe and Upstash Redis, 3
  for Supabase, Railway, Resend, SSH and Gmail, 2 for Vercel and Cloudflare DNS. Resend's
  `read-audiences` / `audience-write` are deprecated in favour of `read-segments` /
  `segment-write`; Supabase's `row-write-one` is deprecated with no successor. A
  deprecated id stays resolvable in the missions and shares that name it.
- **For contributors and plugin authors.** The application is `apps/gateway`, the
  libraries are under `packages/`, each provider is `plugins/<provider>`
  (`@vaubaan/plugin-<provider>`). Next.js 16 with React 19 and zod 4. The documentation
  is in English and describes what the code does: specification, decisions, one handbook
  per subsystem and per provider, test plans, workflow; documents of the hosted product
  are kept under `legacy/` folders. `npm run test:e2e` builds the application and drives
  the standalone server the image runs, with a simulated identity provider and a mocked
  provider; CI installs with `npm ci` and pins every action by commit.

- **The image carries `LICENSE` and `NOTICE`** at `/app`, as a redistribution
  under Apache-2.0 should.

### Removed

- **The hosted application (breaking).** The organization / project / token pages, the
  marketing site, `/api/v1/**`, `/api/integrations/**`, the Supabase-backed gateway and
  the dependencies only they used.
- **Hosted infrastructure.** Supabase migrations and configuration, `vercel.json`, and
  the scripts that only served them.
- **Earlier plugin surface.** The GitHub personal-access-token path, the `venv` tools of
  Supabase and Vercel, the Cloudflare Global API Key (refused), and the annotated-script
  module of the SSH plugin: `ssh__exec` and its classifier are its only surface.
- **The Redis cache client.** The gateway has one bounded, in-process cache; nothing
  depends on an external cache.

### Security

- **A git push that changes CI workflows is decided before anything reaches GitHub.**
  Found on the dogfood instance on 2026-10-16: a mission holding `github.git-push` and
  `github.feature-branch-write` but not `github.workflow-write-via-file` pushed changes to
  `.github/workflows/` through the git remote; the gateway stored the pack at GitHub
  before its review saw the workflow files, and only GitHub's own `workflows` permission
  check refused it. The gateway now reads the pack first, hashes its objects, and compares
  the `.github/workflows` entries of each pushed tip with the ref's current tip (for a new
  branch or tag: the default branch, or a current branch head the push builds on): any
  change — added, modified, deleted, renamed, mode changed, reverted to an older tree —
  needs `github.workflow-write-via-file`, and a mission without it is refused by the
  permission's name with nothing sent. What cannot be read (a garbled or thin pack, an
  object GitHub does not hold, GitHub's API failing, a limit) counts as a change. The
  door now asks git for self-contained packs (`no-thin`), and a push is read into memory
  up to `git.max_pack_mb` before it is sent. ADR `git-push-inspected-before-it-leaves`.
- **A branch built on a large merge already at GitHub is no longer refused by the git
  remote.** Found on the dogfood on 2026-10-16: a branch cut from `main` after `v5` was
  merged into it was refused with "commit 681415ed changes 300 or more files and cannot be
  reviewed" — the review compared it with old work branches rather than with `main`. The
  default branch is now always a candidate base, and a commit GitHub lists 300 files of
  (a large merge, also when merging a moved branch into a work branch) is read by its trees:
  it needs no permission for CI when its workflows equal one of its parents'. ADR
  `gateway-as-git-remote`, amendment of D4 ter.
- **A backup command ships in the image**: `node apps/gateway/backup.mjs` makes a
  consistent, integrity-checked copy of the store on the data volume, read-only, and
  names the master-key versions the copy needs. Take one before a key rotation.
- **Rotating the master key now re-seals what is stored.** `node apps/gateway/reseal.mjs`
  (dry run by default, `--apply` to write) seals every stored credential, configuration
  secret and pending approval argument again under the current key, safely beside the
  running gateway; once it reports every blob under the new version, remove
  `VAUBAAN_MASTER_KEY_PREVIOUS`. Operators: after any suspicion that the key was seen,
  follow `deploy/railway.md` §8.
- **Secrets leave the process environment once loaded.** The master keys, client secrets,
  private keys, the bootstrap token and their `_FILE` paths are deleted from `process.env`
  after the configuration is read; a child process inherits none.
- **A provider's error text is never logged, stored or shown.** Connect failures, discovery
  state, its audit entry and the logs keep the provider's HTTP status in the gateway's own
  words; unexpected errors are logged as class and stack frames; Next's own error printing
  goes through the redactor with messages withheld. The calling agent still gets the
  provider's message on a tool call.
- **`.railwayignore`** keeps env files, keys, `.mcp.json`, the mounted YAML and the agent
  directories out of a `railway up` upload; `.dockerignore` gains the key patterns.
- **The sign-in start, the callbacks and the bootstrap endpoint are rate-limited**, per
  client address when it is known and instance-wide always; 50 wrong bootstrap tokens
  revoke the token.
- **Trusted-edge mode**: `VAUBAAN_CLIENT_IP_HEADER=x-real-ip` reads the client address from
  a header the edge overwrites (Railway). Off by default; verify it first
  (`deploy/railway.md` §2).
- **Pending OAuth registrations are capped (50) and expire after a day**; CORS preflights
  answer a fixed list of headers.
- **An OIDC provider can require a verified email**: `claims.email_verified` (Entra ID:
  `xms_edov`) and `require_verified_email: true`. On Entra ID, make the admin rule a group
  by object id.
- **Sessions end after an hour without use**, and "Sign out everywhere" ends every session
  of a person (Settings for oneself, People for an administrator).
- **Vercel project reads return no env value and no deploy-hook URL**; Railway's agent is
  unavailable on an account that can see the project hosting the gateway; a self resource
  of an unknown provider stops the boot; Upstash database reads hide credentials at the
  source.
- **No read returns a secret value under a permission that is not a secret read**
  (security review 2026-10-15, C1). Supabase `list_function_secrets` returned every
  edge-function secret value — the project's service-role key and database URL among
  them — and `get_auth_config` the OAuth client secrets, SMTP password and hook
  secrets, both under `supabase.read-data`, which every preset carries. Their answers
  now keep an allow-list of non-secret fields; every other value reads
  `[redacted by Vaubaan]`, a field the provider adds later included. The same rule
  covers Vercel `list_env_vars` without `decrypt` (`plain` variables came back in
  clear) and Upstash database answers (any credential-like field). Operators: an
  agent that read those values no longer can; nothing to configure.
- **The instance's own hosting is never reachable by a mission** (security review
  2026-10-15, H1). On Railway the gateway reads `RAILWAY_PROJECT_ID` and refuses its
  own project to every mission: not offered at creation (`resource-self`), refused at
  call time even if an older mission selected it, tagged on the account page. Other
  hosts list theirs in `self_resources` / `VAUBAAN_SELF_RESOURCES`
  (`<provider>:<ref>`). ADR
  [self-resources-never-reachable-by-a-mission](docs/decisions/self-resources-never-reachable-by-a-mission.md).
- **Next.js 16.4.1** (security review 2026-10-15, M1): the advisories published on
  2026-10-14 against 16.4.0 (image optimizer with SVG, `use cache`, Server Actions)
  had no open path here, and the image optimizer is now off
  (`images.unoptimized`): no page uses it, so `/_next/image` is no longer served.
  Operators: redeploy.
- **Every change and every release passes supply-chain checks.** A secret scan of the
  whole history on every push, static analysis (Semgrep: pinned community security rules
  and rules of this codebase), a vulnerability scan of the image that fails on a known
  HIGH or CRITICAL with a fix — also on each architecture of a release before it is
  pushed —, registry signatures of the installed packages, a lockfile that downloads
  only from the npm registry with an integrity hash, and weekly dependency updates that
  wait several days before adopting a version. Every tool is pinned by checksum or
  digest. Operators: nothing to do.
- **The image ships no package manager.** `npm`, `npx`, `corepack` and `yarn` are removed
  from the runner stage: the gateway never runs them, and their dependencies carried
  known vulnerabilities.
- **A release verifies its own attestation before it is published**, the way an operator
  does; `deploy/README.md` documents the identity to check (`gh attestation verify` or
  `cosign`) and how to run the verified digest.
- **The configuration loader cannot be crashed by its file.** A YAML alias used inside
  its own anchor, a `__proto__` key and a duration too long to count in seconds are now
  named issues (exit 78), not a crash at boot.
- **A glob can no longer stall the instance.** SSH: a path glob in an agent's command
  line (`cat ~/.ssh/****…*z`) was matched as a regular expression whose backtracking
  grew exponentially with the stars — two dozen stars held the single process for
  close to a minute, and every other call with it. Slice policies: a bracket glob such
  as `branch[a*a*a*…]` did the same against a long branch name, and a policy can be
  written through the management door. Both now use a linear wildcard matcher with the
  same reading (found by the new Semgrep check).
- **Creating a company app from the page is bound to the administrator's session.**
  Its `state` is random, single use, bound to the web session, and expires after 15
  minutes; the code GitHub returns is exchanged once, server to server, only while no
  app is set and the configuration does not set it. The audit records who created which
  App and the permissions it requested — never a secret.
- **What is executed is what was classified.** Every plugin validates each identifier
  with one grammar used by its classifier and its executor, and refuses what does not
  fit instead of escaping it (a path with `..`, a tag written `refs/tags/…`, a recipient
  list inside one address string). The plugins that forward arguments to the provider —
  Cloudflare DNS, Vercel, Railway, Supabase — refuse an argument the tool does not
  declare, in the classifier and again in the executor. An identifier the slice grammar
  cannot carry is classified as "every instance", never dropped.
- **Plugin classifiers fail closed.** What a classifier cannot place is refused or costs
  the stronger risk. SSH: a line with substitutions, here-documents, inline interpreters
  or unknown wrappers needs every class. Supabase: on prod a migration is limited to
  plain DDL and RLS; unreadable SQL needs every write class; what follows a `--` comment
  ended by a carriage return is read; a column type change is a bulk row write. Railway:
  an `environmentId` and a `serviceId` must belong to the mission's project. Vercel:
  thread tools are refused, a deploy is always prod and takes no `target`, deployment
  tools run only on the mission's project, a foreign `teamId` is refused. GitHub: a
  merge is refused when the pull request's real base is not the declared one. Cloudflare
  DNS: a deletion that does not prove the record ordinary needs `critical-record-write`.
  Resend: envelope headers are refused. Stripe: `cancel_at*` and `auto_advance` need the
  stronger risk, and `read-only` does not cover invoices, charges or payment intents.
  Upstash Redis: every deleting command needs `delete-data`, unknown commands are
  arbitrary execution, and the database token is posted to `https://<name>.upstash.io`
  only. Gmail: unbounded queries and unparseable recipients fail closed, and a
  `no-reply@` sender is "automated" only on a domain the owner listed.
- **The environment of a call is never resolved in the caller's favour.** A call
  touching an env-scoped risk on a resource whose environment the risk is not acceptable
  in — an unlabelled resource, a free-text label, prod for a staging-only risk — is
  refused with `risk-not-accepted`. A call that names several environments, or resources
  of different environments, resolves to none, and an identifier containing `*` is
  refused instead of being read as a pattern. Owners label resources on the account's
  page for env-scoped operations to run.
- **Every refused call is audited, including the one a failing stage refuses.** When the
  resource, risk or budget stage throws (a classifier bug, a store error) the call is
  refused, nothing is counted or sent, and the audit entry names the stage and the error
  class — never the error text, which may quote arguments; the detail is in the instance
  log at `error`. The audit copy of any refusal reason holds no argument value, and a
  provider's error text goes to the calling agent only.
- **A user is the pair (issuer, subject).** A subject reused by another identity
  provider is another person: pointing the instance at a different provider cannot hand
  an existing account, with its connections and missions, to whoever carries the same
  subject there.
- **A sign-in whose groups could not be read is refused** (`groups-unavailable`) instead
  of removing the user from every group. So is a sign-in whose groups the provider moved
  out of the token (Entra ID above its group limit, `groups-overage`) and one whose
  email is marked unverified.
- **A token is issued only to somebody who is on the mission at that instant.** The
  insert re-checks the mission and the holder in its own transaction: a removal, a
  deactivation or a revocation that lands while the token is being generated leaves no
  working token. A member added again starts with no token.
- **A request is decided on the mission as stored at that instant**, and an operator
  reassigns only a connection that is ownerless at the write: both checks are in the
  transaction that writes.
- **An approval is bound to the tool it was read for**: the same arguments sent to
  another tool touching the same risk ask again. A call whose arguments are not JSON
  values (`1e999`) is rejected before any stage, because the approver would have read
  something else.
- **A GitHub App must request user authorization.** Enable "Request user authorization
  (OAuth) during installation", register the gateway callback as the App's callback URL,
  generate a client secret, and add `client_id` / `client_secret` to the provider app.
  The gateway connects an installation only when the person installing can reach it;
  without these settings GitHub is reported `incomplete` and cannot be connected. A
  plugin of the `app-install` kind without such a verification is refused unless an
  operator accepts unverified installations for it (off by default, audited).
- **The admin rule counts groups claimed by the identity provider only.** A local group
  never makes its members operators, and cannot take the name of the admin rule's group.
- **Every page authenticates itself.** Each page and route checks the session instead of
  relying on a layout, every mutating handler passes one origin, session and role guard,
  and a session opened with a revoked bootstrap token is nobody. Return addresses of the
  sign-in and connect flows cannot leave the instance.
- **Sessions and tokens at rest.** The session cookie is `__Host-vbn_session`, which a
  sibling subdomain cannot plant; session rows are keyed by the SHA-256 of the session
  id and mission tokens by a SHA-256 digest, so a copy of the database holds no usable
  credential.
- **The management door checks the client on every request.** A delegated token stops
  working as soon as its client is disabled or no longer approved under the registration
  policy. Token-endpoint limits are spent only by a caller that proved something:
  knowing a `client_id` is not enough to exhaust a client's budget. Client ID Metadata
  Documents are never fetched from private, loopback, link-local or site-local
  addresses.
- **Wrong secrets on a token's prefix never hold its agent.** A mission token is stored
  as a SHA-256 digest: a wrong secret on `/mcp` is answered 401 at once, nothing is
  throttled and nothing about a verification is remembered, so a rotation or a
  revocation is seen by the next call. The one exception is a token issued by an earlier
  build and not used since (see the upgrade notes): its check is throttled per prefix
  and client address. Behind a proxy, set `trusted_proxies`, or every caller shares one
  address for the address-keyed limits; the instance warns at start when it is empty.
- **No telemetry reaches the placeholder collector, whatever is appended to its URL**,
  and a call its caller abandoned is not reported at all.
- **The image and the pipeline.** The image holds what the server needs and nothing
  else: no test file, fixture or simulated identity provider, and a test and the
  container smoke fail if one returns. Base images are pinned by digest and the build
  pulls no unpinned frontend. CI and releases are gated by a dependency audit with a
  reviewed allowlist: every advisory above `low` fails unless allowlisted for that
  package with a review date, and an audit that printed nothing is a broken gate, not a
  pass.

[Unreleased]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.28...HEAD
[2.0.0-alpha.28]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.27...v2.0.0-alpha.28
[2.0.0-alpha.27]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.26...v2.0.0-alpha.27
[2.0.0-alpha.26]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.25...v2.0.0-alpha.26
[2.0.0-alpha.25]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.24...v2.0.0-alpha.25
[2.0.0-alpha.24]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.23...v2.0.0-alpha.24
[2.0.0-alpha.23]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.22...v2.0.0-alpha.23
[2.0.0-alpha.22]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.21...v2.0.0-alpha.22
[2.0.0-alpha.21]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.20...v2.0.0-alpha.21
[2.0.0-alpha.20]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.19...v2.0.0-alpha.20
[2.0.0-alpha.19]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.18...v2.0.0-alpha.19
[2.0.0-alpha.18]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.17...v2.0.0-alpha.18
[2.0.0-alpha.17]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.16...v2.0.0-alpha.17
[2.0.0-alpha.16]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.15...v2.0.0-alpha.16
[2.0.0-alpha.15]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.14...v2.0.0-alpha.15
[2.0.0-alpha.14]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.13...v2.0.0-alpha.14
[2.0.0-alpha.13]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.12...v2.0.0-alpha.13
[2.0.0-alpha.12]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.11...v2.0.0-alpha.12
[2.0.0-alpha.11]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.10...v2.0.0-alpha.11
[2.0.0-alpha.10]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.9...v2.0.0-alpha.10
[2.0.0-alpha.9]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.8...v2.0.0-alpha.9
[2.0.0-alpha.8]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.7...v2.0.0-alpha.8
[2.0.0-alpha.7]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.6...v2.0.0-alpha.7
[2.0.0-alpha.6]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.5...v2.0.0-alpha.6
[2.0.0-alpha.5]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.4...v2.0.0-alpha.5
[2.0.0-alpha.4]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.3...v2.0.0-alpha.4
[2.0.0-alpha.3]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.2...v2.0.0-alpha.3
[2.0.0-alpha.2]: https://github.com/vaubaan/gateway/compare/v2.0.0-alpha.1...v2.0.0-alpha.2
[2.0.0-alpha.1]: https://github.com/vaubaan/gateway/compare/v4-final...v2.0.0-alpha.1
