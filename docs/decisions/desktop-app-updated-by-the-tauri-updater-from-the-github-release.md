---
title: The desktop app updates itself with Tauri's updater, from a signed archive and a latest.json attached to the GitHub release
status: accepted
date: 2026-11-27
author: Renaud Pelissier
---

# The desktop app updates itself with Tauri's updater, from a signed archive and a latest.json attached to the GitHub release

## Context

The desktop app ([desktop-app-tauri-shell-over-the-node-standalone-server](./desktop-app-tauri-shell-over-the-node-standalone-server.md))
had no way to update: a person had to notice a release, download the `.dmg` and drag the app again.
The update must be offered, never forced, keep the store and the Keychain item, leave the running
version in place when it fails, and say when it fixes a security issue. Every release so far is a
pre-release, which GitHub's `releases/latest` address never names, and the bundle's version is the
numeric core of the gateway's (`2.0.0` for every `2.0.0-alpha.n`), so two alphas look the same to
macOS.

## Decision

The shell embeds Tauri's updater plugin. After the gateway answers, then every six hours, it reads
`https://vaubaan.com/desktop/latest.json`, a temporary redirect the site builds from the released
version (`releases.json`) to the `latest.json` attached to that GitHub release. The release job
writes `latest.json` (version, notes, date, `security`, one signed `.app.tar.gz` per architecture)
and attaches it with the archives. The archives are signed with an updater key of their own
(minisign, distinct from Apple's), whose public half is built into the app. The bundle's version
becomes the whole gateway version, pre-release included (`CFBundleVersion` keeps the numeric core):
the updater compares it with the manifest's, and the archive's signature carries it, so a manifest
cannot pair a newer version with an older signed archive. A native dialog
shows the notes; on "Install and relaunch" the shell downloads and checks the archive, stops the
server, replaces the app and relaunches it, and starts the server again if the replacement failed.

## Consequences

- The store and the key live outside the bundle (Application Support, Keychain), so replacing the
  app keeps them; the Keychain lets the new app read the key because it carries the same Developer
  ID and identifier.
- A release without the updater secrets ships its `.dmg` files and no `latest.json`: installed apps
  see nothing new. The first version with the updater is installed by hand.
- Between the site's deployment and the release job's end, the redirect names a file not yet
  attached: the check fails quietly and the next one finds it.
- The app makes one request of its own (the manifest), with no payload; the trust center lists it.

## Rejected alternatives

### `releases/latest/download/latest.json` on GitHub alone

No moving part on the site, but it skips pre-releases: no alpha would ever be offered.

### A release tag rewritten on every release to hold the manifest

Works on GitHub alone, but a fake release among the versions, and a tag that moves.

### Sparkle, or the gateway downloading the app

Sparkle duplicates what Tauri ships and needs its own appcast and keys; the gateway in local mode
would need a desktop code path, which the shell's ADR excludes.
