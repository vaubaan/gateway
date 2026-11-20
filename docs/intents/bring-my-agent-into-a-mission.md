---
title: Bring my agent into a mission
status: proposed
actors: [user, agent]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-20
---

# Bring my agent into a mission

As a person who created a mission, I want my agent set up and kept informed without copying
configuration or relaying answers by hand, so that it works alone within what I allowed.

## Add a mission to my agent in one step

status: proposed
requires: mission
spec: ../spec/vaubaan-gateway.md#44-bootstrap-kit-after-issuance
acceptance:

- One action on the mission page writes the MCP configuration, the token variable, the instruction block and the git helper into a project, for Claude Code and for Cursor
- Running it twice changes nothing; the token never lands in a file tracked by git

## Connect a desktop assistant without editing a config file

status: proposed
requires: mission
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- A person adds a mission to Claude Desktop from the mission page, with no file to edit
- The assistant's first call lists the mission's tools; revoking the mission ends its access

## Let my agent know my answer

status: proposed
requires: request, approval
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- After I approve or refuse a request, the agent learns the answer at its next call, without a person relaying it
- The gateway never holds a call open while waiting for me

## Read what a refusal means

status: proposed
requires: mission
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- Every refusal carries a stable link to the user docs, at the anchor of its code
- That page lists every refusal code the gateway emits, with what the agent and the person do next

## List only the tools a mission can call

status: proposed
requires: mission
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- The tool list a mission's agent receives leaves out the tools no permission of the mission allows
- A tool hidden this way still answers with its refusal code if called by name

## Let my agent find the resources of its mission

status: proposed
requires: mission
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- A service's list tool answers the mission's resources of that account, at least id and name, and says the others are left out
- A resource named by its id or by the name the service shows is accepted alike
- Every argument a plugin requires to route a call is declared in that tool's input schema
- A tool the service no longer exposes fails with a message that names the plugin as behind the service
