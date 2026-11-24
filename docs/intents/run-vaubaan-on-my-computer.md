---
title: Run Vaubaan on my computer
status: proposed
actors: [developer, consultant]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-24
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
- No domain name, certificate or sign-in provider is asked; the command's output prints the setup link, and the first person signs in with a sign-in account it creates
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
- The first launch opens the interface on `localhost` and asks only for my name and a password: no domain name, no sign-in provider, no command
- The master key lives in the macOS Keychain, never in a file next to the store
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
- The first launch opens the interface on `localhost` and asks only for my name and a password
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
