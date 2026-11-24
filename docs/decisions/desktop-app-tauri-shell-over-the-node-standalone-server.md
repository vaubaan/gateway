---
title: The desktop app is a Tauri shell that runs the image's standalone server on the official Node binary and shows it in the system webview
status: accepted
date: 2026-11-24
author: Renaud Pelissier
---

# The desktop app is a Tauri shell that runs the image's standalone server on the official Node binary and shows it in the system webview

## Context

One person must run Vaubaan on macOS or Windows with no server, no domain name and no command. The
gateway is a Next.js standalone server on Node 26 with native addons (`better-sqlite3`, `argon2`,
`ssh2`) loaded from N-API prebuilts ([docker-image-and-config-format](./docker-image-and-config-format.md)).
The desktop app must keep the master key in the system's credential store, update itself, and be
signed and notarized.

## Decision

The desktop app is a Tauri 2 shell that starts the official Node 26 binary as a sidecar on the
unchanged standalone output of the image build, bound to `localhost`, and shows the interface in the
system webview. The shell holds the master key in the system credential store and hands it to the
Node process at start on its standard input, never a file or an environment variable.

## Consequences

- The desktop app and the image run the same build with the same Node and the same prebuilts: no
  desktop-only code path in `apps/gateway`, no addon rebuilt for another ABI.
- The interface must work in WKWebView and WebView2; a flow that leaves the window (an OAuth
  consent) opens the default browser and comes back through `localhost`.
- The setup still hands the key over for download
  ([master-key-generated-and-handed-over-by-the-instance](./master-key-generated-and-handed-over-by-the-instance.md)):
  the credential store is not a backup.
- The release signs the Node binary and every `.node` under the hardened runtime (JIT
  entitlements); the repository gains a Rust crate and its toolchain in CI.

## Rejected alternatives

### Electron

Its embedded Node follows Node majors with a delay and needs the addons rebuilt for its ABI;
keeping Node 26 means shipping a second Node beside Chromium, the heaviest option.

### A launcher that opens the default browser

Smallest, but the updater, the credential store and the signing are all ours to write, and the
interface lives in a browser tab the person can close without stopping the instance.
