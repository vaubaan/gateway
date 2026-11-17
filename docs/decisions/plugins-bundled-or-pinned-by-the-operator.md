---
title: A plugin is a self-contained archive an operator can pin in a directory; the pin wins and a bad one stops the boot
status: accepted
date: 2026-11-05
---

# A plugin is a self-contained archive an operator can pin in a directory; the pin wins and a bad one stops the boot

Where plugins come from, and how an instance installs and activates them besides the operator's
directory, is decided by [plugin-catalog-rebuilt-from-source](./plugin-catalog-rebuilt-from-source.md)
and [plugins-activated-by-an-administrator-on-trial](./plugins-activated-by-an-administrator-on-trial.md)
(2026-11-17), which replace this record's bundled tier and its "nothing is fetched" rule.

## Context

Every plugin ships in the image, so a fix to one plugin is a gateway release and every operator
re-pulls sixteen plugins to get it; a stricter classification in one plugin reaches an instance
with the gateway update it wanted for another reason; and the list keeps growing. Three promises
pull against each other: a working plugin must not change under its operator, a security fix must
reach every instance, and an instance should carry what it uses. A plugin runs in the process with
the credential, so it is in the trusted computing base whatever the way it was delivered; the
[rewrap ADR](./rewrap-official-mcps.md) already refused third-party code fetched at run time.

## Decision

- **Two tiers.** _Bundled_ plugins are the folders of `plugins/`, versioned, tested and released
  with the gateway, covered by its semver (a plugin major waits for a gateway major, a stricter
  classification that is a security fix is a patch). _Pinned_ plugins are directories under
  `plugins.dir` (`/plugins` in the image, nothing by default elsewhere), one per plugin, placed by
  the operator: a `package.json` naming the plugin, its version and the SDK range it was built
  against (`peerDependencies["@vaubaan/plugin-sdk"]`), one self-contained ESM entry with its own
  copy of the SDK, and `risk-catalog.yaml` beside it. The release workflow publishes every bundled
  plugin in that shape as `ghcr.io/vaubaan/plugin-<id>:<version>`; a tag `plugin-<id>-v<version>`
  publishes one plugin alone, the path of a fix that waits for no gateway release. An operator
  composes an image (`COPY --from=ghcr.io/vaubaan/plugin-<id>:<version> /plugin /plugins/<id>`)
  or mounts the directory; the gateway never downloads code.
- **The pin wins.** A pinned plugin with the id of a bundled one replaces it, in either direction
  (a fix ahead of the image, or the former version kept while missions are reviewed); the
  replacement is logged at boot and shown in Administration → Plugins and the Reference, never
  silent.
- **Fail closed at boot.** A pinned plugin outside the host SDK's range, refused by `definePlugin`,
  or duplicating another pinned id stops the boot with the path, as an invalid key does. So does a
  provider the store holds accounts for and no loaded plugin serves, whether disabled or missing,
  naming the provider and how many accounts.
- **`plugins.enabled`** lists the plugin ids an instance registers; unset, every bundled and
  pinned plugin is registered. A disabled plugin is absent from the registry: no picker entry, no
  tools, no Reference page.
- **The host identifies an SDK error by its brand, never by `instanceof`.** A pinned plugin carries
  its own SDK copy, so the SDK exports guards (`isUpstreamAuthError`…) keyed on a
  `Symbol.for` brand, and a lint rule refuses `instanceof` on an SDK class outside the SDK.
- **Information travels, code does not.** The site publishes `versions.json`: the released gateway
  version, each plugin's released version and the advisories. An instance fetches it at boot and
  daily (`updates.check`, on by default; `updates.feed_url`), a GET with no query, no body and no
  identifier, compares locally and shows in Administration → Plugins what is behind, what carries an
  advisory, and which pins are older than what the image bundles.

## Consequences

- A mission is untouched by any of this: its policy copies the risk ids at issuance, a catalog id
  is never renamed or removed, so a loaded version only ever narrows what a call may do, and a
  narrowing is a refusal with a permission request, never a wider blast radius.
- A plugin bundle is one esbuild output; a plugin whose dependency needs a native addon is bundled
  only (`bundleable: false`) until that changes.
- `release-prepare` writes the released versions the site serves; advisories are a committed file
  with the fixed version, written in the fix's pull request.
- A gateway major that drops a bundled plugin stops an instance that still holds accounts of it:
  the release notes say to disconnect or pin first, which is what a major means.

## Rejected alternatives

### One SDK instance shared through a resolve hook

The host's SDK lives inside the server bundle; shipping it a second time as a real package to
share it would still leave two copies in every test and dev run. Brands cost one guard per class.

### A provider with accounts but no plugin shown as "not loaded" everywhere

Every page that names a service would need a path for an unknown one; a refusal at boot with the
count of accounts is one message, and the operator decides.

### Plugin majors allowed in gateway minors

Breaks the one promise an operator of bundled plugins has; a pin gives the same freedom to whoever
wants it.
