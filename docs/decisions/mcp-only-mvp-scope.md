---
title: MCP only — no CLI or SDK proxy
status: accepted
date: 2026-05-22
---

# MCP only — no CLI or SDK proxy

## Context

A coding agent reaches a service through MCP tool calls, through a CLI in its terminal, or through
an SDK or HTTPS API in its own code. The gateway can only govern the calls that pass through it,
and anything it installs on the agent's machine is friction and attack surface.

## Decision

The gateway intercepts MCP calls only (its git remote is a gateway door, not an interception). An
agent running a CLI or an SDK with its own credentials bypasses it; the protection is that the
agent never holds a provider credential.

## Consequences

- Nothing to install on the client but an MCP entry and a token; any MCP client works.
- A new way for agents to reach a service is a new gateway door (like the git remote), never a
  wrapper on the agent's machine.
- The product claims a policy gateway for agent tool calls, not a kill switch for every agent
  action.

## Rejected alternatives

### A CLI proxy

PATH shims and wrappers per CLI leave an immense bypass surface (`/usr/bin/git`, scripts) and heavy
install friction.

### TLS man-in-the-middle

A root CA on the client affects every HTTPS call of the machine: a security red flag and an
onboarding blocker.

### A runtime sandbox on the client (eBPF, nsjail)

OS-specific, heavy to install, outside the product's scope.
