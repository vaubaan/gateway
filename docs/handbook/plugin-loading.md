---
title: Plugin loading — bundled, pinned, enabled, and the versions check
tracks:
  - apps/gateway/src/server/plugins/
  - apps/gateway/src/server/updates/
  - apps/gateway/src/server/compose/root.ts
  - apps/gateway/src/server/compose/shipped-plugins.ts
  - apps/gateway/src/server/reseal/cli.ts
  - apps/gateway/src/app/admin/(guarded)/plugins/
  - apps/gateway/src/app/(app)/reference/frame.tsx
  - apps/website/src/app/versions.json/route.ts
  - apps/website/src/content/versions-feed.ts
  - packages/shared/src/brand.ts
  - packages/shared/src/versions-feed.ts
  - scripts/build-plugin-bundle.mjs
  - scripts/publish-plugin-images.sh
  - scripts/plugin-release-plan.mjs
  - deploy/docker/plugin.Dockerfile
  - deploy/docker/plugin.Dockerfile.dockerignore
last_reviewed: 2026-11-13
---

# Plugin loading — handbook

How the registry is composed at boot from the bundled plugins and the operator's pins, and how the
instance learns what is behind. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.3, §5, §7.11;
ADR [plugins-bundled-or-pinned-by-the-operator](../decisions/plugins-bundled-or-pinned-by-the-operator.md).

## Start here

- [`plugins/index.ts`](../../apps/gateway/src/server/plugins/index.ts) — `loadPlugins`, what `buildRoot` runs; `root.plugins` is its inventory.
- [`plugins/loader.ts`](../../apps/gateway/src/server/plugins/loader.ts) — one pin directory read, checked, imported.
- [`plugins/inventory.ts`](../../apps/gateway/src/server/plugins/inventory.ts) — the pin wins, `plugins.enabled`, the accounts check.
- [`updates/index.ts`](../../apps/gateway/src/server/updates/index.ts) — the daily read of `versions.json`; `root.updates`.
- [`scripts/build-plugin-bundle.mjs`](../../scripts/build-plugin-bundle.mjs) — the bundle a pin is; the release workflow runs it.
- `apps/gateway/src/app/admin/(guarded)/plugins/` — Administration › Plugins: `page.tsx` reads `root.plugins`, `root.updates`, the account counts and the badges; `plugins-view.tsx` says it; `check/route.ts` is "Check now" (`updates/handlers.ts`, not audited: it changes nothing).
- `apps/gateway/src/app/(app)/reference/frame.tsx` — `PinnedTag`, the "pinned" tag the Reference shows from the inventory.
- [`apps/website/src/app/versions.json/route.ts`](../../apps/website/src/app/versions.json/route.ts) — the feed instances read, built at build time by `content/versions-feed.ts` ([website](website.md)).

## Invariants

- **The pin wins, never silently**: one `info` line per pin at boot (`… pinned from <dir> (replaces bundled <v>)`) and one for the plugins `plugins.enabled` leaves out.
- **Fail closed at boot**: every refusal is a `ConfigError` (exit 78) whose message holds the pin's directory, or names the provider and its account count. A pin is never skipped.
- **The accounts check runs after the store opens** (`root.ts`, before the sealed-keys probe): it counts connections not revoked, so a revoked account of a dropped plugin does not block.
- **The host reads SDK errors by brand only** (`isUpstreamAuthError`…, [plugin-sdk](plugin-sdk.md)): a pin carries its own SDK copy. `loader.test.ts` proves `instanceof` is false on a real bundle.
- **`package.json` version = `plugin.version`** for a pin, as for a bundled plugin; a mismatch is refused.
- **A pin never declares a `host` account**: such a plugin runs on the gateway's own services, which only the image binds (the `vaubaan` plugin, [providers/vaubaan](providers/vaubaan.md)); the loader refuses it and the bundle script skips it (`"vaubaan": { "bundleable": false }`).
- **Nothing about the instance leaves with the feed request**: `User-Agent: vaubaan-gateway` (no version), no query added, no body. The feed is untrusted: `isVersionsFeed` bounds every string and allows https links only, since Administration will render them.

## Traps

- **A gateway upgrade can refuse a pin**: the SDK range is checked with `semver.satisfies` (prereleases included), and before SDK `1.0.0` `^0.6.0` holds one minor. The message names the range and the host SDK version: rebuild the pin for the new gateway.
- **The import is a native `import()`** with `webpackIgnore` / `turbopackIgnore`: the file is the operator's, read at run time, never traced into the standalone output. Keep both comments.
- **`/plugins` is root's in the image** (0755): the gateway reads it, never writes it, so a compromised process cannot plant code for the next start.
- **Tests never read the feed**: `validEnv()` sets `VAUBAAN_UPDATES_CHECK=false`. A test that wants the check sets it back and injects `updatesFetch` (`RootDeps`).
- **`RootDeps.buildRegistry`** bypasses the loader: the inventory then lists the injected plugins as bundled, and no pin is read. `reseal` runs `loadPlugins` like the root, so a pin that stops the boot stops it too (exit 78).
- **The e2e instance never reads the feed** (`VAUBAAN_UPDATES_CHECK=false` in `ephemeral-instance.ts`): Administration › Plugins shows no notice there, only "the versions check is off". A notice is tested on the view (`tests/unit/app/admin-plugins.test.tsx`).
- **A bundle inlines JSON imports**, but a file read at run time (`catalogPathNextTo`) must be copied beside `index.js`: the script copies `src/*.yaml`, and `docs/connect/` (the connect guide's screenshots, which the host serves from `<pin>/docs/connect/`; a pin built before 2026-11-13 has none and its images answer 404). A plugin reading another file needs the script taught.
- **A native addon cannot be bundled** (esbuild has no `.node` loader): the plugin declares `"vaubaan": { "bundleable": false, "reason": … }` (today `ssh`) and stays image-only.
- **The plugin image's context** is filtered by `plugin.Dockerfile.dockerignore` (BuildKit reads it before the root `.dockerignore`, which excludes `dist/`).
- **A plugin image version never moves**: a gateway release skips versions already on GHCR; a `plugin-<id>-v<version>` tag on an existing version fails.

## Debug

- **Exit 78 naming `plugins.dir`** → a pin directory: the message says which check (range, manifest, catalog, import, `definePlugin`, duplicate id).
- **Exit 78 "the store holds N accounts of '<id>'"** → `plugins.enabled` leaves it out, or the image no longer bundles it: enable or pin it; disconnect those accounts on an instance that still serves them.
- **`versions feed not read`** in the log → `failure` says why (`unreachable`, `timeout`, `http-status`, `too-large`, `not-json`, `not-a-feed`); the last good report stays.
