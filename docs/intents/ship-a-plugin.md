---
title: Ship a plugin
status: proposed
actors: [author, agent]
spec: ../spec/plugin-authoring.md
last_reviewed: 2026-11-17
---

# Ship a plugin

As an author, I want to write a plugin outside the gateway's repository with my coding agent, then
run it on my gateway or publish it to the catalog, without learning the gateway's code.

## Write a plugin

### Start a plugin project

status: proposed
requires: kit
creates: scaffold
spec: ../spec/plugin-authoring.md#1-vision
acceptance:

- One command in an empty directory makes a project whose checks pass before any change
- The project holds the skills for the supported coding agents and a build that signs

### Try a call without a gateway

status: proposed
requires: scaffold
spec: ../spec/plugin-authoring.md#1-vision
acceptance:

- Given a tool and its arguments, the command line prints the slices, the permissions touched and the decision against a sample mission
- The kit's checks exit non-zero, naming the tool, when a write is classified as a read

### Let my agent build the plugin

status: proposed
requires: skill, scaffold
spec: ../spec/plugin-authoring.md#1-vision
acceptance:

- An agent with no prior context, in an empty directory, reaches a plugin whose checks pass for a real small service, stopping for a human on each write risk and on the credential choice
- Each skill ends on a command whose exit code says whether its step is done

## Run it on my gateway

### Sign a private plugin

status: proposed
requires: archive
creates: signer
spec: ../spec/plugin-authoring.md#1-vision
acceptance:

- One command makes a company key and prints the public part to add as a trusted signer
- The build signs the archive with it; nothing about the plugin is sent anywhere

### Deploy a plugin to a gateway

status: proposed
requires: archive
spec: ../spec/plugin-authoring.md#1-vision
acceptance:

- One command uploads the archive to a gateway and prints the activation page's URL
- It never activates the plugin

### Rebuild a plugin for a newer gateway

status: proposed
requires: archive
spec: ../spec/plugin-authoring.md#1-vision
acceptance:

- A gateway refusing a plugin for its SDK range names the command that rebuilds it
- A skill migrates the plugin to the newer SDK and the rebuilt archive is accepted

## Publish it to the catalog

### Submit a plugin to the catalog

status: proposed
requires: scaffold
creates: submission
spec: ../spec/plugin-authoring.md#2-submission
acceptance:

- One command checks the plugin, writes its declaration and opens the change on the catalog
- The change's build runs without secrets and reports the risk catalog, each tool's classification, the dependencies added and the execution code's diff
- Once accepted, the archive is published signed by Vaubaan and the plugin appears in the versions feed and on its page
- Only the owners the declaration names can change it
