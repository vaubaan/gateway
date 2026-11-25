---
title: Desktop app
tracks:
  - apps/desktop/
  - .github/workflows/desktop.yml
last_reviewed: 2026-11-24
---

# Desktop app — handbook

Vaubaan as a macOS app: a Tauri shell that starts the official Node binary on the
gateway's standalone server in local mode and shows it in the system webview (ADR
[desktop-app-tauri-shell-over-the-node-standalone-server](../decisions/desktop-app-tauri-shell-over-the-node-standalone-server.md),
[local-mode-for-an-instance-on-this-computer](../decisions/local-mode-for-an-instance-on-this-computer.md)).
Intent: [run Vaubaan on my computer](../intents/run-vaubaan-on-my-computer.md).

## Start here

- [`src-tauri/src/main.rs`](../../apps/desktop/src-tauri/src/main.rs) — the whole shell: key, start, window, navigation, stop.
- [`scripts/assemble.mjs`](../../apps/desktop/scripts/assemble.mjs) — copies the standalone output and fetches Node for one target.
- [`desktop.yml`](../../.github/workflows/desktop.yml) — the only place the app is built, signed, notarized and opened.

## Invariants

- **No desktop code in the gateway**: the shell sets variables a docker run could set (`VAUBAAN_LOCAL`, `VAUBAAN_PUBLIC_URL`, `VAUBAAN_STORE_PATH`, `PORT`, `HOSTNAME=127.0.0.1`) and passes the key with `VAUBAAN_MASTER_KEY_FILE=/dev/stdin`, then closes standard input.
- **One Node version**: `assemble.mjs` reads it from `deploy/docker/Dockerfile` and checks the archive against nodejs.org's `SHASUMS256.txt`.
- **The key never exists as a file**: Keychain item service `com.vaubaan.desktop`, account `master-key`. The shell makes one only when there is neither a key nor a store with data; a store without its key is a refusal shown in the window.
- **The setup link never reaches the log**: the shell keeps it from the gateway's output and writes a placeholder line.
- **The webview saves no download by itself**: WKWebView drops a response with `Content-Disposition: attachment` (the key on `/welcome` and in Settings) unless the shell takes it. `on_download` saves it in `~/Downloads` under a free name and reveals it in the Finder.
- **Only the gateway stays in the window**: any other address (a service's sign-in page, the docs) opens in the default browser (`is_inside`).

## Traps

- **Port 3100 is fixed**: agents' configurations and the OAuth clients registered at services hold it. A docker run on 3100, or a gateway left running, makes the app refuse to start with a sentence.
- **A killed shell leaves its server running** (SIGTERM or a crash skips the exit hook): the next start finds port 3100 taken. Quit with Cmd-Q; `pkill -f apps/gateway/server.js` frees it.
- **The crate does not compile on Linux without a macOS SDK** (`objc2-exception-helper` needs Apple's headers): the macOS job is the compiler. Run it by hand (Actions › desktop › Run workflow) before pushing a change to `main.rs`.
- **argon2 ships no darwin-x64 prebuild**: on an Intel Mac npm compiles it into `build/Release/`, which `next.config.ts` traces; `assemble.mjs` fails when neither binary is in the tree.
- **The app bundler drops symbolic links**: Next's standalone output links `apps/gateway/.next/node_modules/<package>-<hash>` to each external package (better-sqlite3, argon2, ssh2). `assemble.mjs` (`replaceLinks`) turns each into a package re-exporting the real one; without it the gateway stops at boot with `Cannot find module 'better-sqlite3-<hash>'`.
- **Notarization refuses any unsigned Mach-O**: the job signs every Mach-O file of the resources (found with `file`, not by extension: a `.dylib` beside an addon counts) and the Node binary (with `entitlements.plist`: JIT) before the bundler signs the app.
- **The bundler notarizes the app, not the `.dmg`**: an image downloaded from a release is checked when it is opened, so the job notarizes and staples the `.dmg` as well (`notarytool`, then `stapler`). Check one with `spctl -a -vv -t open --context context:primary-signature <file>.dmg` (`source=Notarized Developer ID`).
- **sharp is left out** (`NEVER_LOADED` in `assemble.mjs`): Next traces its image optimizer and libvips although the gateway turns it off (`images.unoptimized`); in the app it was only unsigned native code.
- **Tauri CLI and crate move together** (`TAURI_CLI` in the workflow, `tauri` in `Cargo.lock`, same minor).

## Procedures

- **Signing secrets**: the six `APPLE_*` secrets listed in the workflow's header, all or none. Without them the job builds an unsigned `.dmg` and warns.
- **A release**: the tag's run attaches the signed `.dmg` files to the GitHub release (job `desktop-assets` of `release.yml`); the bundle's version is the numeric core of the gateway's (`2.0.0` for `2.0.0-alpha.31`), the file name carries the whole version.
- **Try a build**: download the artifact `vaubaan-desktop-<target>` of a run; an unsigned app opens with right-click › Open.

## Debug

- **The window says the gateway stopped**: `~/Library/Application Support/com.vaubaan.desktop/gateway.log` holds what it printed.
- **Start over** (loses every account and mission): quit, delete that folder and the Keychain item `com.vaubaan.desktop`.
