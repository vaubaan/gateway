---
title: Bring my agent into a mission
status: proposed
actors: [developer, consultant, teammate]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-27
---

# Bring my agent into a mission

As a person who created a mission, I want my agent set up and kept informed without copying
configuration or relaying answers by hand, so that it works alone within what I allowed.

## Add a mission to my agent in one step

The key never sits in clear in a file, and Vaubaan writes into no file of another application
([ADR, proposed](../decisions/mission-key-reaches-an-agent-through-its-own-secret-store.md)).

### Add a mission to Claude Code with one line

status: proposed
relieves: four-copy-pastes-per-project
requires: mission, mission-token
spec: ../spec/vaubaan-gateway.md#44-bootstrap-kit-after-issuance
acceptance:

- The page that shows the key gives one line to run; after it, Claude Code lists the mission's tools, with no file edited and no variable exported by hand
- In the desktop app, the key is in the macOS Keychain and in no file: neither the line nor Claude Code's configuration holds it
- Running the line twice changes nothing; replacing or revoking the key ends what the Keychain held
- Outside the desktop app, the line names the environment variable and the key stays out of every file

### Connect a desktop assistant without editing a config file

status: proposed
relieves: a-configuration-file-to-edit
requires: mission, mission-token
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- From the page that shows the key, I open a file Claude Desktop installs, and paste the key once where it asks: no file to edit, no terminal
- The key is kept by the operating system's secret store, and the file I opened holds none
- The assistant's first call lists the mission's tools; revoking the mission ends its access
- Two missions added this way stay two servers in the assistant, each named after its mission

### Add a mission to Cursor from the page

status: proposed
relieves: four-copy-pastes-per-project
requires: mission, mission-token
spec: ../spec/vaubaan-gateway.md#44-bootstrap-kit-after-issuance
acceptance:

- One link on the page adds the mission's server to Cursor, the key never in clear in its configuration

## Tell my agent what its mission is without pasting anything

status: implemented
relieves: four-copy-pastes-per-project
requires: mission, mission-token
anchors: apps/gateway/src/server/missions/bootstrap-kit.ts, apps/gateway/src/server/execution/door.ts, apps/gateway/src/server/missions/bootstrap-kit.test.ts, apps/gateway/tests/integration/accounts/token-connect.test.ts
spec: ../spec/vaubaan-gateway.md#44-bootstrap-kit-after-issuance

## Let my agent know my answer

status: proposed
relieves: relaying-my-yes-by-hand
requires: request, approval
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- After I approve or refuse a request, the agent learns the answer at its next call, without a person relaying it
- The gateway never holds a call open while waiting for me

## Read what a refusal means

status: proposed
relieves: an-agent-that-keeps-hitting-walls
requires: mission
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- Every refusal carries a stable link to the user docs, at the anchor of its code
- That page lists every refusal code the gateway emits, with what the agent and the person do next

## List only the tools a mission can call

status: proposed
relieves: an-agent-that-keeps-hitting-walls
requires: mission
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- The tool list a mission's agent receives leaves out the tools no permission of the mission allows
- A tool hidden this way still answers with its refusal code if called by name

## Let my agent find the resources of its mission

status: proposed
relieves: an-agent-that-keeps-hitting-walls
requires: mission
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- A service's list tool answers the mission's resources of that account, at least id and name, and says the others are left out
- A resource named by its id or by the name the service shows is accepted alike
- Every argument a plugin requires to route a call is declared in that tool's input schema
- A tool the service no longer exposes fails with a message that names the plugin as behind the service
