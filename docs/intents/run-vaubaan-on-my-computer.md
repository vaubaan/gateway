---
title: Run Vaubaan on my computer
status: proposed
actors: [developer, consultant]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-26
---

# Run Vaubaan on my computer

As one person, I want Vaubaan to run on my own computer with no server, no domain name and no
sign-in provider, so that I give my agents missions today and bring my team later.

## Run a local instance with one docker command

status: implemented
anchors: apps/gateway/src/server/config/sources.ts, apps/gateway/src/server/compose/boot.ts, apps/gateway/tests/integration/compose/local-mode.test.ts
relieves: a-lost-evening-on-pre-release-software
delivers: my-first-governed-call-in-minutes
creates: instance
spec: ../spec/vaubaan-gateway.md#71-install-an-instance
acceptance:

- `docker run -p 127.0.0.1:3000:3000 -v vaubaan:/data -e VAUBAAN_LOCAL=true` with the image starts an instance on `http://localhost:3000`, on amd64 and arm64
- No domain name, certificate or sign-in provider is asked; the command's output prints the setup link, which opens the same two screens (the key, then an email and a password)
- Safari, Chrome and Firefox keep the session on `http://localhost`
- The page says the instance answers on this computer only

## Install the desktop app

The app is a Tauri shell over the same standalone server as the image
([ADR](../decisions/desktop-app-tauri-shell-over-the-node-standalone-server.md)). It comes after the
docker command, which proves the instance without a domain name or a sign-in provider first.

### Install Vaubaan on my Mac

status: proposed
relieves: a-lost-evening-on-pre-release-software, no-way-to-try-without-a-terminal
delivers: installed-like-any-other-app, my-first-governed-call-in-minutes
creates: instance
spec: ../spec/vaubaan-gateway.md#71-install-an-instance
acceptance:

- A signed, notarized `.dmg` opens without a Gatekeeper warning, on Apple silicon and on Intel
- The first launch opens the setup on `localhost` with no link to copy and two screens: I keep my encryption key, then I type an email and a password and land on Vaubaan's home; no token shown, no second factor asked, no domain name, no sign-in provider, no command
- The master key lives in the macOS Keychain, never in a file next to the store; the instance reads it on its standard input
- The setup still asks me to download a copy of the key: the only way to open a backup on another computer
- Quitting the app stops the instance; reopening it finds my accounts and missions unchanged

### Install Vaubaan on Windows

status: proposed
relieves: a-lost-evening-on-pre-release-software, no-way-to-try-without-a-terminal
delivers: installed-like-any-other-app, my-first-governed-call-in-minutes
creates: instance
spec: ../spec/vaubaan-gateway.md#71-install-an-instance
acceptance:

- A signed installer runs without a SmartScreen warning, with no administrator rights
- The first launch opens the setup on `localhost` with no link to copy and two screens: I keep my encryption key, then I type an email and a password
- The master key lives in the Windows credential store, never in a file next to the store
- The setup still asks me to download a copy of the key: the only way to open a backup on another computer
- Quitting the app stops the instance; reopening it finds my accounts and missions unchanged

### Update the desktop app

status: proposed
requires: instance
spec: ../spec/vaubaan-gateway.md#71-install-an-instance
acceptance:

- The app says when a release is out, with its notes, and installs it only when I accept
- An update keeps the store, the master key and every account; a failed update leaves the former version running
- A security patch is marked as such, as on the versions feed

## Get back into my instance when I forget my password

An instance on my computer sends no mail: the encryption key I kept at the setup is the way back.

### Choose a new password with my encryption key

status: implemented
requires: instance, sign-in-account
creates: web-session
anchors: apps/gateway/src/app/(public)/sign-in-account/forgot/page.tsx, apps/gateway/src/components/auth/RecoverWithKey.tsx, apps/gateway/src/server/auth/local-handlers.ts, apps/gateway/src/server/auth/recovery.ts, apps/gateway/tests/integration/auth/recovery-password.test.ts
spec: ../spec/vaubaan-gateway.md#6-security

### Choose a new password with Touch ID in the desktop app

status: proposed
requires: instance, sign-in-account
creates: web-session
spec: ../spec/vaubaan-gateway.md#6-security
acceptance:

- In the app, "Forgot your password?" asks Touch ID or my Mac's password, then the new password, with no key file to find
- The app reads the key from the Keychain only after that check, and the reset leaves the same audit entry, banner and notification as with the key file

## Use my Google, Microsoft and GitHub accounts with no client of my own

The instance carries Vaubaan's installed-app clients, one per provider, for signing in and for the
services, back on the loopback ([ADR](../decisions/local-instance-carries-installed-oauth-clients.md)).

### Sign in with Google, Microsoft or GitHub on my computer

status: proposed
requires: instance
creates: web-session
relieves: a-lost-evening-on-pre-release-software
delivers: my-first-governed-call-in-minutes
spec: ../spec/vaubaan-gateway.md#6-security
acceptance:

- The setup and the sign-in page offer Google, Microsoft, GitHub and email with a password; the setup's second screen creates the first administrator with whichever I choose
- In the desktop app the provider's page opens in my default browser; once I consent, the browser says to go back to Vaubaan and the app's window is signed in
- Signing in asks only my identity (Google `openid email`, Microsoft `openid email profile`, GitHub `read:user user:email`), never a calendar or a mailbox
- A flow finished in another browser than the one that started it, or replayed, signs nobody in
- A build without a provider's client shows no button for that provider

### Connect Google Calendar and Outlook with no client of my own

status: proposed
requires: instance
creates: account
relieves: my-own-google-client-to-create
delivers: my-first-governed-call-in-minutes
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- With no broker and nothing in Settings, Connect an account connects Google Calendar and Outlook, and my agent lists that account's events and mail
- The consent asks the plugin's scopes only, even when I signed in with the same Google or Microsoft account
- The refresh token stays on my computer, sealed under the master key; the account page says it signed in through Vaubaan's client on this computer
- Gmail still connects with an app password over IMAP

### Reach my Google Drive

status: proposed
requires: instance
creates: account
relieves: my-own-google-client-to-create
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- A `google-drive` plugin connects with Vaubaan's Google client; its agent lists a folder, searches, reads a file (a Google Doc, Sheet or Slides as text), uploads a file and creates a folder
- No tool shares or deletes a file
- Until Google's review, the consent screen warns of an unverified app; the plugin's page says so before I connect

### Reach my OneDrive

status: proposed
requires: instance
creates: account
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- A `onedrive` plugin connects with Vaubaan's Microsoft client, personal or work account; its agent lists a folder, searches, reads a file, uploads a file and creates a folder
- No tool shares or deletes a file

### Open the app when port 3100 is taken

status: proposed
requires: instance
relieves: a-lost-evening-on-pre-release-software
acceptance:

- With port 3100 taken, the app starts on another free port instead of refusing, and keeps that port at the next launches while it stays free
- The page that gives my agent its configuration shows the port the app answers on
- Signing in and connecting accounts work on that port without changing anything at Google, Microsoft or GitHub

## Reach my agent's first call in one path

status: proposed
requires: instance
creates: account, mission, mission-token
relieves: a-lost-evening-on-pre-release-software, four-copy-pastes-per-project
delivers: my-first-governed-call-in-minutes
spec: ../spec/vaubaan-gateway.md#7-workflows
acceptance:

- After the first launch, the interface leads from connecting an account to creating a mission to adding it to my agent, each step opening the next
- From download to my agent's first governed call takes at most six actions of mine, counted as in plate 7 of the 2026-11-19 research
- A step one person does not need (giving access, labelling environments no permission uses) is skipped, not shown

## Let my agent reach the instance on my computer

status: proposed
requires: instance, mission
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- An agent on the same computer calls the execution surface on `localhost` with its mission token
- A call from another machine on the network is refused, unless I turn sharing on and the page warns me
