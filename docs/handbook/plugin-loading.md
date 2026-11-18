---
title: Plugin loading — bundled, installed, pinned, enabled, and the versions check
tracks:
  - apps/gateway/src/server/plugins/
  - apps/gateway/src/server/updates/
  - apps/gateway/src/server/compose/root.ts
  - apps/gateway/src/server/compose/installed-plugins.ts
  - apps/gateway/src/server/compose/registry.ts
  - apps/gateway/src/server/store/repositories/plugin-versions.ts
  - apps/gateway/migrations/0041_plugin_versions.sql
  - packages/plugin-sdk/src/archive/
  - apps/gateway/src/server/plugins/trust.ts
  - apps/gateway/src/server/plugins/socle.ts
  - deploy/socle.json
  - scripts/fetch-socle.mjs
  - apps/gateway/src/server/plugins/sigstore-trusted-root.json
  - apps/gateway/src/server/store/repositories/plugin-signers.ts
  - apps/gateway/migrations/0042_plugin_signers.sql
  - scripts/fetch-sigstore-root.mjs
  - apps/gateway/src/server/compose/shipped-plugins.ts
  - apps/gateway/src/server/reseal/cli.ts
  - apps/gateway/src/app/admin/(guarded)/plugins/
  - apps/gateway/src/app/(app)/reference/frame.tsx
  - apps/website/src/app/versions.json/route.ts
  - apps/website/src/content/versions-feed.ts
  - packages/shared/src/brand.ts
  - packages/shared/src/versions-feed.ts
  - scripts/build-plugin-bundle.mjs
  - packages/plugin-cli/
  - scripts/publish-plugin-images.sh
  - scripts/plugin-release-plan.mjs
  - deploy/docker/plugin.Dockerfile
  - deploy/docker/plugin.Dockerfile.dockerignore
last_reviewed: 2026-11-17
---

# Plugin loading — handbook

How the registry is composed at boot from the image's plugins, the versions an administrator
installed and the operator's pins, and how the instance learns what is behind. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2, §4.3, §5, §7.11; ADRs
[plugins-bundled-or-pinned-by-the-operator](../decisions/plugins-bundled-or-pinned-by-the-operator.md),
[plugins-activated-by-an-administrator-on-trial](../decisions/plugins-activated-by-an-administrator-on-trial.md).
[plugin-signature-sets-the-trust-level](../decisions/plugin-signature-sets-the-trust-level.md),
[plugin-catalog-rebuilt-from-source](../decisions/plugin-catalog-rebuilt-from-source.md) (the
catalog is [vaubaan/gateway-plugins](https://github.com/vaubaan/gateway-plugins); the image still
compiles its plugins in: preinstalling them from the catalog is a later step).

## Start here

- [`plugins/index.ts`](../../apps/gateway/src/server/plugins/index.ts) — `loadPlugins`, what `buildRoot` runs; `root.plugins` is its inventory.
- [`plugins/loader.ts`](../../apps/gateway/src/server/plugins/loader.ts) — one pin directory read, checked, imported.
- [`plugins/inventory.ts`](../../apps/gateway/src/server/plugins/inventory.ts) — the pin wins, `plugins.enabled`, the accounts check.
- [`compose/installed-plugins.ts`](../../apps/gateway/src/server/compose/installed-plugins.ts) — `startInstalledPlugins`: the store's `trial` and `active` versions loaded from `<data dir>/plugins/<digest>` (`plugins/installed.ts` `loadInstalled`), what each trial became recorded and audited (`plugin-trial-ended`, actor `startup`).
- [`plugins/installed.ts`](../../apps/gateway/src/server/plugins/installed.ts) — `storeArchive` (checks an upload without running it, writes it atomically), `installedFolderProblem` (the folder against its manifest, at every start), `examplesProblem` (the trial's health check).
- [`plugins/install-service.ts`](../../apps/gateway/src/server/plugins/install-service.ts) and [`plugins/handlers.ts`](../../apps/gateway/src/server/plugins/handlers.ts) — upload, activate (the id typed), refuse, follow the image, restart; `root.pluginInstall`. The routes are `app/admin/(guarded)/plugins/<act>/route.ts`.
- [`store/repositories/plugin-versions.ts`](../../apps/gateway/src/server/store/repositories/plugin-versions.ts) — the states of a version (migration 0041).
- [`packages/plugin-sdk/src/archive/`](../../packages/plugin-sdk/src/archive/index.ts) — the archive format both sides share: a deterministic ustar subset, gzipped, read only when it is exactly its manifest; `signature.ts`, a company key's ed25519 signature of the manifest.
- [`plugins/socle.ts`](../../apps/gateway/src/server/plugins/socle.ts) — the socle: [`deploy/socle.json`](../../deploy/socle.json) lists the catalog releases the image preinstalls, each pinned by its archive's sha256; `scripts/fetch-socle.mjs` downloads, checks and unpacks them at image build into `/app/socle/<id>/` (root-owned, stage `socle` of the Dockerfile); `loadSocle` checks each folder at every start like an installed version (digests, the catalog's signature only, SDK range, import) and `composePlugins` runs it **in place of the compiled copy, only at the very version compiled**: until the compiled copies leave the server, the image runs the catalog's build of the same plugin and nothing else changes. A folder that fails is logged at `error` ("the socle's archive is not used") and the compiled copy runs: a broken socle never stops a start. The entry stays `origin: 'bundled'`, with `path` (connect guide files) and `trust: 'vaubaan'`. `tests/unit/structural/socle.test.ts` holds every entry to the compiled version; `smoke.sh` checks every archive runs in the image. **Trap:** a plugin's version bump in this repository fails that test until the catalog published the version and `socle.json` names it — or the entry leaves `socle.json` meanwhile.
- [`plugins/catalog.ts`](../../apps/gateway/src/server/plugins/catalog.ts) — the one-click install (`installFromCatalog`, route `install-catalog`): `<CATALOG_RELEASES_URL><id>-v<version>/<id>-v<version>.tgz`, a GET like the feed's (generic user agent, no credentials, 60 s, 16 MB), redirects followed because GitHub serves assets from another host and nothing is trusted from where it came: the archive is kept only if `trustOf` says `vaubaan` **and** it is the id and version asked for, whatever `plugins.allow_unsigned` says. The buttons come from the versions feed (`pluginsBehind`, `pluginsAvailable` of `updates/compare.ts`); a feed version the catalog has not published yet answers `not-in-catalog`. **Invariant:** a refused upload deletes its folder only if it created it and no version records that digest (`StoredArchive.created`): the same bytes always land in the same folder, which a kept version may already use.
- [`plugins/trust.ts`](../../apps/gateway/src/server/plugins/trust.ts) — `trustOf` (vaubaan, signer, unsigned, invalid) and `admissionProblem`, the one rule at upload and at every start (`installedAdmission` in `compose/root.ts`). **Reserved ids differ on purpose:** at upload, the image's ids and every id the last versions feed named (`catalogIds`, the catalog's); at a start, the image's only, so a private plugin already installed keeps running the day the catalog publishes its id. With `updates.check` off, the catalog's ids are unknown and only the image's are reserved. Trusted signers: `store/repositories/plugin-signers.ts` (migration 0042).
- [`updates/index.ts`](../../apps/gateway/src/server/updates/index.ts) — the daily read of `versions.json`; `root.updates`.
- [`packages/plugin-cli/src/archive.ts`](../../packages/plugin-cli/src/archive.ts) — `buildArchive`, the archive a pin is (`vaubaan-plugin build` for an author): the bundle, its YAML, its `package.json` under the plugin's own name and licence, and `vaubaan-manifest.json`, the sha256 of every other file, which a signature will cover.
- [`packages/plugin-cli/src/init.ts`](../../packages/plugin-cli/src/init.ts) — `vaubaan-plugin init <dir> --id <id>`: `plugins/_template` renamed by case (`TEMPLATE`, `Template`, `template` before a capital, any other `template` → the id), made standalone, plus `packages/plugin-cli/scaffold/` (the author's `AGENTS.md`, `README.md` and skills, copied to `.claude/skills` and `.agents/skills`). **Trap:** a change to `plugins/_template` changes every new project — keep its ids in `src/identity.ts` and the word `template` only in names; `tests/unit/init-and-try.test.ts` runs a generated project's own `tsc` and tests. Published, the CLI reads its own `template/` copy: the publication must copy `plugins/_template` there.
- [`packages/plugin-cli/src/try.ts`](../../packages/plugin-cli/src/try.ts) — `vaubaan-plugin try <tool> [args]`: the project's plugin bundled by esbuild first (plain Node cannot strip every TypeScript form, the SDK's own source included), its YAML copied beside the bundle, then `decideCall` under a sample mission (every macro-action at `--trust`, default careful, or `--accept`). Exit 0 only when allowed. In this repository the CLI runs under `tsx` (`npx tsx packages/plugin-cli/src/cli.ts …`).
- [`packages/plugin-cli/src/deploy.ts`](../../packages/plugin-cli/src/deploy.ts) — `vaubaan-plugin deploy --gateway <url>`: one stateless `tools/call` of `vaubaan__upload_plugin` on `<gateway>/mcp`, the mission token from `VAUBAAN_MISSION_TOKEN` only (never an argument), https unless localhost. **Trap:** the mission must be issued by an administrator **and** tick "Install plugins" (`vaubaan.plugin-upload`); without it the door refuses `risk-not-accepted` before the administrator check. Proof against a real door: `tests/integration/plugins/deploy-from-cli.test.ts`.
- [`packages/plugin-cli/src/submit.ts`](../../packages/plugin-cli/src/submit.ts) — `vaubaan-plugin submit [--owners] [--dry-run]`: the declaration of the project's pushed HEAD (clean tree, on a remote branch, GitHub origin, `package-lock.json`), checked against the catalog's own rules (`scripts/declarations.mjs` of vaubaan/gateway-plugins: keep the two in step), then `gh repo fork --clone`, a branch `submit/<id>-<version>`, a signed-off commit, `gh pr create --head <login>:<branch>`.
- [`scripts/build-plugin-bundle.mjs`](../../scripts/build-plugin-bundle.mjs) — the repository's plugins through `buildArchive` (`--all`, the project's `LICENSE`); the release workflow runs it.
- `apps/gateway/src/app/admin/(guarded)/plugins/` — Administration › Plugins: `page.tsx` reads `root.plugins`, `root.updates`, the account counts and the badges; `plugins-view.tsx` says it; `check/route.ts` is "Check now" (`updates/handlers.ts`, not audited: it changes nothing).
- `apps/gateway/src/app/(app)/reference/frame.tsx` — `PinnedTag`, the "pinned" tag the Reference shows from the inventory.
- [`apps/website/src/app/versions.json/route.ts`](../../apps/website/src/app/versions.json/route.ts) — the feed instances read, built at build time by `content/versions-feed.ts` ([website](website.md)).

## Invariants

- **Precedence**: a pin wins over an installed version, which wins over the image's (`composePlugins`); an installed version's entry has origin `installed` and `replaces` the image's version.
- **An upload runs nothing**: `storeArchive` reads the manifest, `package.json`, the SDK range and the catalog; no `import()` happens before a start, and only of a version marked `trial` or `active`.
- **A start never stops on an installed version**: a trial that does not load is `failed` and the `active` one is loaded; an `active` one that no longer loads (folder modified, SDK range, import) is `failed` too and the plugin falls back to the pin or the image's. Only the operator's pins keep failing closed (exit 78).
- **The store opens before the plugins** (`buildRoot`): its `CatalogIndex` is a `DeferredCatalogIndex` filled once they load, with `KeptCatalogIndex`: the registry's ids plus the base ids of every kept version (`trial`, `active`, `previous`), so a mission keeps saving after going back to an older version. Nothing writes a risk id before the fill.
- **"Vaubaan" is an exact identity**: the Sigstore certificate's SAN equals the catalog's `release.yml@refs/heads/main`, extension `.1.8` the GitHub issuer, `.1.15` the catalog repository's numeric id (`VAUBAAN_CATALOG_IDENTITY`). `@sigstore/verify`'s own policy matches strings as unanchored patterns: never hand it the identity, compare the fields.
- **Verification never touches the network**: `Verifier` over the embedded `sigstore-trusted-root.json` (protobuf JSON, about 7 KB). `node scripts/fetch-sigstore-root.mjs --check` before a release says whether Sigstore added a key since; refresh it with the same script without `--check`.
- **Reserved ids**: an id of the image's plugins installs only signed by Vaubaan, whatever `plugins.allow_unsigned` says. A version admitted at upload is checked again at every start: a signer removed, or `allow_unsigned` narrowed, turns it away (`failed`) and the plugin falls back.
- **The feed follows the signer** (`updates/compare.ts`): an installed version not signed by Vaubaan is never compared with the catalog's plugin of the same id.
- **One `active` and one `trial` per plugin** (partial unique indexes); `prune` keeps two `previous` versions and deletes the folders of the others.

- **The pin wins, never silently**: one `info` line per pin at boot (`… pinned from <dir> (replaces bundled <v>)`) and one for the plugins `plugins.enabled` leaves out.
- **Fail closed at boot**: every refusal is a `ConfigError` (exit 78) whose message holds the pin's directory, or names the service and its account count. A pin is never skipped.
- **The accounts check runs after the store opens** (`root.ts`, before the sealed-keys probe): it counts accounts not revoked, so a revoked account of a dropped plugin does not block.
- **The host reads SDK errors by brand only** (`isUpstreamAuthError`…, [plugin-sdk](plugin-sdk.md)): a pin carries its own SDK copy. `loader.test.ts` proves `instanceof` is false on a real bundle.
- **`package.json` version = `plugin.version`** for a pin, as for a bundled plugin; a mismatch is refused.
- **A pin never declares a `host` account**: such a plugin runs on the gateway's own services, which only the image binds (the `vaubaan` plugin, [services/vaubaan](services/vaubaan.md)); the loader refuses it and the bundle script skips it (`"vaubaan": { "bundleable": false }`).
- **Nothing about the instance leaves with the feed request**: `User-Agent: vaubaan-gateway` (no version), no query added, no body. The feed is untrusted: `isVersionsFeed` bounds every string and allows https links only, since Administration will render them.

## Traps

- **The upload route is outside the proxy** (`proxy.ts` matcher, like `/git/`): the proxy buffers bodies up to `proxyClientMaxBodySize` and truncates the rest; an archive may reach 16 MB.
- **"Restart now" ends the process with exit 75** once the root is closed (`defaultRestart`): a supervisor that restarts on failure starts it again. Under a supervisor that does not, the instance stays down: restart it by hand. Tests pass `RootDeps.requestRestart`.
- **`reseal` does not load installed versions**: it rewrites sealed columns only and never a risk id, so the image's and pinned catalogs are enough.
- **A store in memory installs nothing** (`installedDirFor(':memory:')` is `null`): the e2e instance and most tests cannot upload; `tests/integration/plugins/` use a store file.

- **A gateway upgrade can refuse a pin**: the SDK range is checked with `semver.satisfies` (prereleases included), and before SDK `1.0.0` `^0.6.0` holds one minor. The message names the range and the host SDK version: rebuild the pin for the new gateway.
- **A pin of an SDK before 0.9.4 says provider**: its own SDK copy wrote `provider` in its catalog, data model, slices and resources. `readPinnedPlugins` passes such a plugin (`isLegacyPlugin`: its catalog names a `provider`, no `service`) through `fromLegacyPlugin` before the registry checks it, so the host reads `service` and the plugin still reads `provider` (`loader.test.ts`, "reads a bundle of an SDK before 0.9.4"). Gone in SDK 0.10.
- **The import is a native `import()`** with `webpackIgnore` / `turbopackIgnore`: the file is the operator's, read at run time, never traced into the standalone output. Keep both comments.
- **`/plugins` is root's in the image** (0755): the gateway reads it, never writes it, so a compromised process cannot plant code for the next start.
- **Tests never read the feed**: `validEnv()` sets `VAUBAAN_UPDATES_CHECK=false`. A test that wants the check sets it back and injects `updatesFetch` (`RootDeps`).
- **`RootDeps.buildRegistry`** bypasses the loader: the inventory then lists the injected plugins as bundled, and no pin is read. `reseal` runs `loadPlugins` like the root, so a pin that stops the boot stops it too (exit 78).
- **The e2e instance never reads the feed** (`VAUBAAN_UPDATES_CHECK=false` in `ephemeral-instance.ts`): Administration › Plugins shows no notice there, only "the versions check is off". A notice is tested on the view (`tests/unit/app/admin-plugins.test.tsx`).
- **A bundle inlines JSON imports**, but a file read at run time (`catalogPathNextTo`) must be copied beside `index.js`: `buildArchive` copies `src/*.yaml`, and `docs/connect/` (the connect guide's screenshots, which the host serves from `<pin>/docs/connect/`; a pin built before 2026-11-13 has none and its images answer 404). A plugin reading another file needs `buildArchive` taught.
- **A native addon cannot be bundled** (esbuild has no `.node` loader): the plugin declares `"vaubaan": { "bundleable": false, "reason": … }` (today `ssh`) and stays image-only.
- **The plugin image's context** is filtered by `plugin.Dockerfile.dockerignore` (BuildKit reads it before the root `.dockerignore`, which excludes `dist/`).
- **A plugin image version never moves**: a gateway release skips versions already on GHCR; a `plugin-<id>-v<version>` tag on an existing version fails.

## Debug

- **Exit 78 naming `plugins.dir`** → a pin directory: the message says which check (range, manifest, catalog, import, `definePlugin`, duplicate id).
- **Exit 78 "the store holds N accounts of '<id>'"** → `plugins.enabled` leaves it out, or the image no longer bundles it: enable or pin it; disconnect those accounts on an instance that still serves them.
- **`versions feed not read`** in the log → `failure` says why (`unreachable`, `timeout`, `http-status`, `too-large`, `not-json`, `not-a-feed`); the last good report stays.
