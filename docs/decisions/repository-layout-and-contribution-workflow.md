---
title: One npm-workspaces monorepo split into apps, packages and plugins; plugins never import the application
status: accepted
date: 2026-10-13
---

# One npm-workspaces monorepo split into apps, packages and plugins; plugins never import the application

## Context

The gateway is an open source, on-prem product extended by third-party provider plugins. It has
one deployable (the server and its UI), a public site, shared libraries and a growing set of
plugins, three audiences that must find where their code goes. A change to the plugin contract
must land atomically with the plugins it touches. Procedures (branches, release, versioning):
[coding-workflow](../workflow/coding-workflow.md).

## Decision

One repository with npm workspaces on `apps/*` (private deployables: `gateway`, `website`),
`packages/*` (`@vaubaan/` libraries) and `plugins/<provider id>/` (one plugin per folder). A plugin
imports only `@vaubaan/shared`, `@vaubaan/policy-engine` and `@vaubaan/plugin-sdk`, never an app;
nothing is published to npm, the image is the only artefact.

## Consequences

- Adding a plugin or a library under an existing root needs no configuration change.
- A plugin that needs something from the application gets it through the SDK contract, not an
  import; the boundary is what lets a plugin live outside this repository later.
- Workspaces keep version `0.0.0`; the one product version lives in the root `package.json`.

## Rejected alternatives

### One flat `packages/` for everything

Mixes three audiences and hides the one deployable; "where do I add a provider" becomes a doc
question.

### One repository per plugin

Multiplies CI and loses atomic changes across the plugin contract; the `plugins/` folder keeps that
door open.

### pnpm, yarn or Turborepo

A tooling migration with no need the npm workspaces leave unmet.
