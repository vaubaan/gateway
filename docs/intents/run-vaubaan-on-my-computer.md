---
title: Run Vaubaan on my computer
status: proposed
actors: [user, administrator]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-20
---

# Run Vaubaan on my computer

As one person, I want Vaubaan to run on my own computer with no server, no domain name and no
sign-in provider, so that I give my agents missions today and bring my team later.

## Install the desktop app

### Install Vaubaan on my Mac

status: proposed
creates: instance
spec: ../spec/vaubaan-gateway.md#71-install-an-instance
acceptance:

- A signed, notarized `.dmg` opens without a Gatekeeper warning, on Apple silicon and on Intel
- The first launch opens the interface on `localhost` and asks only for my name and a password: no domain name, no sign-in provider, no command
- The master key lives in the macOS Keychain, never in a file next to the store
- Quitting the app stops the instance; reopening it finds my accounts and missions unchanged

### Install Vaubaan on Windows

status: proposed
creates: instance
spec: ../spec/vaubaan-gateway.md#71-install-an-instance
acceptance:

- A signed installer runs without a SmartScreen warning, with no administrator rights
- The first launch opens the interface on `localhost` and asks only for my name and a password
- The master key lives in the Windows credential store, never in a file next to the store
- Quitting the app stops the instance; reopening it finds my accounts and missions unchanged

### Update the desktop app

status: proposed
requires: instance
spec: ../spec/vaubaan-gateway.md#71-install-an-instance
acceptance:

- The app says when a release is out, with its notes, and installs it only when I accept
- An update keeps the store, the master key and every account; a failed update leaves the former version running
- A security patch is marked as such, as on the versions feed

## Run a local instance with one docker command

status: proposed
creates: instance
spec: ../spec/vaubaan-gateway.md#71-install-an-instance
acceptance:

- `docker run` with one volume and one published port starts an instance reachable on `localhost`, on amd64 and arm64
- No domain name, certificate or sign-in provider is asked; the first person signs in with a local account
- The page says the instance answers on this computer only

## Let my agent reach the instance on my computer

status: proposed
requires: instance, mission
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- An agent on the same computer calls the execution surface on `localhost` with its mission token
- A call from another machine on the network is refused, unless I turn sharing on and the page warns me
