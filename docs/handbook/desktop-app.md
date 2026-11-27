---
title: Desktop app
tracks:
  - apps/desktop/
  - .github/workflows/desktop.yml
  - apps/website/src/site/desktop-update.ts
last_reviewed: 2026-11-27
---

# Desktop app — handbook

Vaubaan as a macOS app: a Tauri shell that starts the official Node binary on the
gateway's standalone server in local mode and shows it in the system webview (ADR
[desktop-app-tauri-shell-over-the-node-standalone-server](../decisions/desktop-app-tauri-shell-over-the-node-standalone-server.md),
[local-mode-for-an-instance-on-this-computer](../decisions/local-mode-for-an-instance-on-this-computer.md)).
Updates: ADR [desktop-app-updated-by-the-tauri-updater-from-the-github-release](../decisions/desktop-app-updated-by-the-tauri-updater-from-the-github-release.md).
Intent: [run Vaubaan on my computer](../intents/run-vaubaan-on-my-computer.md).

## Start here

- [`src-tauri/src/main.rs`](../../apps/desktop/src-tauri/src/main.rs) — the whole shell: key, start, window, navigation, stop.
- [`src-tauri/src/update.rs`](../../apps/desktop/src-tauri/src/update.rs) — the update: check, dialog, download, stop, replace, relaunch.
- [`scripts/update-manifest.mjs`](../../apps/desktop/scripts/update-manifest.mjs) — writes a release's `latest.json` (release job `desktop-assets`).
- [`scripts/assemble.mjs`](../../apps/desktop/scripts/assemble.mjs) — copies the standalone output and fetches Node for one target.
- [`desktop.yml`](../../.github/workflows/desktop.yml) — the only place the app is built, signed, notarized and opened.

## Invariants

- **No desktop code in the gateway**: the shell sets variables a docker run could set (`VAUBAAN_LOCAL`, `VAUBAAN_PUBLIC_URL`, `VAUBAAN_STORE_PATH`, `PORT`, `HOSTNAME=127.0.0.1`) and passes the key with `VAUBAAN_MASTER_KEY_FILE=/dev/stdin`, then closes standard input.
- **One Node version**: `assemble.mjs` reads it from `deploy/docker/Dockerfile` and checks the archive against nodejs.org's `SHASUMS256.txt`.
- **The key never exists as a file**: Keychain item service `com.vaubaan.desktop`, account `master-key`. The shell makes one only when there is neither a key nor a store with data; a store without its key is a refusal shown in the window.
- **The setup link never reaches the log**: the shell keeps it from the gateway's output and writes a placeholder line.
- **The webview saves no download by itself**: WKWebView drops a response with `Content-Disposition: attachment` (the key on `/welcome` and in Settings) unless the shell takes it. `on_download` saves it in `~/Downloads` under a free name and reveals it in the Finder.
- **Only the gateway stays in the window**: any other address (a service's sign-in page, the docs) opens in the default browser (`is_inside`).
- **No page calls the shell**: the capability grants nothing, so neither the gateway's pages nor the start page can reach the dialog or updater plugins; only the Rust code uses them.
- **Nothing is downloaded before a yes**: the check reads the manifest only; a declined version is not offered again until the app restarts.
- **The bundle's version is the gateway's whole version** (`2.0.0-alpha.33`), `CFBundleVersion` its numeric core: the updater compares the full version with the manifest's (semver, pre-release included), and `tauri build` writes it in the archive's signature, which the plugin checks against the manifest (`requireSignedVersion`).
- **The update chain**: the app reads `https://vaubaan.com/desktop/latest.json` (`plugins.updater.endpoints`), a temporary redirect the site builds from `src/content/releases.json` to `https://github.com/vaubaan/gateway/releases/download/v<version>/latest.json`; that file names `Vaubaan-<version>-<arm64|x64>.app.tar.gz` and its signature. `security: true` (a `### Security` heading in the version's CHANGELOG section, or a gateway advisory of `advisories.json` fixed by it) turns the dialog into a security update.

## Traps

- **The port moves only when it must**: agents' configurations hold it, so the shell tries the port of the last start (`port` in the data folder), then 3100, then the next free one up to 3199, and passes it in `VAUBAAN_PUBLIC_URL`. A port is free when nothing answers on it _and_ it binds on loopback: on macOS a bind succeeds beside a docker run published on every interface. An agent configured on the former port must take the new one from the app.
- **A killed shell leaves its server running** (SIGTERM or a crash skips the exit hook): the next start reads `gateway.pid` in the data folder and stops that process, only if its command line is this app's `server.js`, before choosing a port.
- **The crate does not compile on Linux without a macOS SDK** (`objc2-exception-helper` needs Apple's headers): the macOS job is the compiler. Run it by hand (Actions › desktop › Run workflow) before pushing a change to `main.rs`.
- **argon2 ships no darwin-x64 prebuild**: on an Intel Mac npm compiles it into `build/Release/`, which `next.config.ts` traces; `assemble.mjs` fails when neither binary is in the tree.
- **Node is a resource, not a sidecar** (`resources/runtime/node`, not Tauri's `externalBin`): a binary in `Contents/MacOS` is taken for an app of the bundle and shows in the Dock as `node` with a terminal icon.
- **The app bundler drops symbolic links**: Next's standalone output links `apps/gateway/.next/node_modules/<package>-<hash>` to each external package (better-sqlite3, argon2, ssh2). `assemble.mjs` (`replaceLinks`) turns each into a package re-exporting the real one; without it the gateway stops at boot with `Cannot find module 'better-sqlite3-<hash>'`.
- **Notarization refuses any unsigned Mach-O**: the job signs every Mach-O file of the resources (found with `file`, not by extension: a `.dylib` beside an addon counts) and the Node binary (with `entitlements.plist`: JIT) before the bundler signs the app.
- **The bundler notarizes the app, not the `.dmg`**: an image downloaded from a release is checked when it is opened, so the job notarizes and staples the `.dmg` as well (`notarytool`, then `stapler`). Check one with `spctl -a -vv -t open --context context:primary-signature <file>.dmg` (`source=Notarized Developer ID`).
- **sharp is left out** (`NEVER_LOADED` in `assemble.mjs`): Next traces its image optimizer and libvips although the gateway turns it off (`images.unoptimized`); in the app it was only unsigned native code.
- **The app looks for updates only when built with the updater's public key**: `tauri.conf.json` keeps `pubkey` empty, the workflow fills it from the variable `DESKTOP_UPDATER_PUBKEY`. A local build or a run without the key never checks.
- **A mismatched key only warns at build time** (`tauri build` signs anyway): every installed app then refuses the update. The private key and the variable must come from the same `signer generate`.
- **A version released without the updater key is a dead end** for updates: installed apps of that version find nothing, and the next version must be installed by hand. The first version with the updater (2.0.0-alpha.32 or later) is always installed by hand.
- **Between the site's deployment and the release job's end** (≈ 45 min) the redirect ends on a 404; the app writes `updater: check failed` in its log and tries again six hours later, or at the next launch.
- **The Keychain item follows the signature**: the new app reads the key without a prompt because it carries the same Developer ID and identifier. An ad hoc signed build (no Apple secrets) asks for the Mac's password after each replacement.
- **Replacing needs write access to the app's folder**: in `/Applications` on an administrator's account the updater writes directly; otherwise macOS asks for an administrator's password.
- **Tauri CLI and crate move together** (`TAURI_CLI` in the workflow, `tauri` in `Cargo.lock`, same minor).

## Procedures

- **Updater key** (once, by the operator, on their own machine; never in the repository): generate it with a password, then hand it to GitHub:

  ```bash
  npx @tauri-apps/cli@2.12.4 signer generate -w ~/.tauri/vaubaan-desktop-updater.key
  gh secret set TAURI_SIGNING_PRIVATE_KEY --repo vaubaan/gateway < ~/.tauri/vaubaan-desktop-updater.key
  gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo vaubaan/gateway   # prompts for it
  gh variable set DESKTOP_UPDATER_PUBKEY --repo vaubaan/gateway < ~/.tauri/vaubaan-desktop-updater.key.pub
  ```

  Keep the private key and its password in the password manager: losing it means every installed app must be reinstalled by hand to take a new key.

- **Signing secrets**: the six `APPLE_*` secrets listed in the workflow's header, all or none. Without them the job builds an unsigned `.dmg` and warns.
- **A release**: the tag's run attaches the signed `.dmg` files to the GitHub release (job `desktop-assets` of `release.yml`); the bundle's version is the numeric core of the gateway's (`2.0.0` for `2.0.0-alpha.31`), the file name carries the whole version.
- **A release, for updates**: with the updater key, the run also attaches `Vaubaan-<version>-<arch>.app.tar.gz`, its `.sig` and `latest.json`, the manifest last. Check it with `curl -sL https://vaubaan.com/desktop/latest.json | jq .version` once the site is deployed and the release job is green.
- **Test an update** (needs a Mac and two releases built with the updater key; no agent can run it):
  1. Install version N from its release's `.dmg` (drag to `/Applications`), open it, finish the setup, connect one account, create one mission.
  2. Release N+1 (tag, release run green, site deployed). `curl -sL https://vaubaan.com/desktop/latest.json | jq '.version, .security'` answers N+1.
  3. Quit and reopen Vaubaan: once the window shows the gateway, a dialog names N+1, the version running and the notes. Click **Later**: nothing is downloaded and it is not asked again until the next launch.
  4. Reopen, click **Install and relaunch**: the window says "Installing Vaubaan N+1…", the app closes and opens again within a minute. Check: `curl -s http://127.0.0.1:3100/healthz` answers N+1, the account and mission are there, no Keychain prompt appeared, `gateway.log` ends with `updater: installed N+1, relaunching`.
  5. Failure path (optional): cut the network after clicking **Install and relaunch** with a large download pending, or make `/Applications/Vaubaan.app` read-only (`chmod -R a-w`) before accepting: an error dialog says the running version stays, and the gateway answers again on N.
- **Try a build**: download the artifact `vaubaan-desktop-<target>` of a run; an unsigned app opens with right-click › Open.

## Debug

- **An update is not offered**: `grep updater: ~/Library/Application\ Support/com.vaubaan.desktop/gateway.log` says what the last check met; `defaults read /Applications/Vaubaan.app/Contents/Info.plist CFBundleShortVersionString` gives the version the app compares.
- **The window says the gateway stopped**: `~/Library/Application Support/com.vaubaan.desktop/gateway.log` holds what it printed.
- **Start over** (loses every account and mission): quit, delete that folder and the Keychain item `com.vaubaan.desktop`.
